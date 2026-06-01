/*
 * main.js
 *
 * Self-hosted, OpenAI-compatible chat backend for the RStudio AI pane.
 *
 * This process is launched by RStudio (see SessionChat.cpp) in place of the
 * proprietary Posit Assistant backend. It speaks a small JSON protocol over a
 * WebSocket to the chat client UI (dist/client), and relays conversation turns
 * to any OpenAI-compatible /v1/chat/completions endpoint. No account, sign-in,
 * or telemetry is involved -- all configuration comes from the environment
 * variables RStudio sets from the user's preferences:
 *
 *   RSTUDIO_AI_API_KEY              API key (Bearer token)
 *   RSTUDIO_AI_BASE_URL             Base URL, e.g. https://api.openai.com/v1
 *   RSTUDIO_AI_MODEL                Model name, e.g. gpt-4o
 *   RSTUDIO_AI_THINKING             "1" / "0"  - request + show reasoning
 *   RSTUDIO_AI_INTERLEAVED_THINKING "1" / "0"  - stream reasoning inline
 *   RSTUDIO_AI_MAX_CONTEXT          integer    - max context window (tokens)
 *   RSTUDIO_CHAT_AUTH_TOKEN         per-session WebSocket auth token
 *
 * Communication with the RStudio C++ backend uses stdin/stdout with LSP-style
 * Content-Length framing (same as the Language Server Protocol). The backend
 * writes JSON-RPC 2.0 requests to stdout; RStudio responds via stdin. This
 * enables the backend to call RStudio capabilities like runtime/getDetailedContext
 * and workspace/insertAtCursor.
 *
 * The backend is intentionally dependency-free: it uses only Node built-ins
 * plus the global fetch() available in Node 18+, so it can be dropped into an
 * installation tree and run without `npm install`.
 */

'use strict';

const http = require('http');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

// ---------------------------------------------------------------------------
// Argument parsing (lenient: RStudio passes flags we don't all need)
// ---------------------------------------------------------------------------

function parseArgs(argv)
{
   const opts = { host: '127.0.0.1', port: 0, serverMode: false };
   for (let i = 0; i < argv.length; i++)
   {
      const arg = argv[i];
      const next = () => argv[++i];
      if (arg === '-h' || arg === '--host') opts.host = next();
      else if (arg === '-p' || arg === '--port') opts.port = parseInt(next(), 10);
      else if (arg === '--config') opts.config = next();
      else if (arg === '--storage') opts.storage = next();
      else if (arg === '--workspace') opts.workspace = next();
      else if (arg === '--workspace-id') opts.workspaceId = next();
      else if (arg === '--log-dir') opts.logDir = next();
      else if (arg === '--server-mode') opts.serverMode = true;
      else if (arg === '--allowed-origin') opts.allowedOrigin = next();
      else if (arg.startsWith('--log-dir=')) opts.logDir = arg.slice('--log-dir='.length);
      else if (arg.startsWith('--logger-type=')) { /* ignored */ }
      // --json, --resume-conversation, --logger-type, etc. are accepted and ignored
   }
   return opts;
}

const ARGS = parseArgs(process.argv.slice(2));

// ---------------------------------------------------------------------------
// Logging (stderr, plus optional log file under --log-dir)
// ---------------------------------------------------------------------------

let logStream = null;
if (ARGS.logDir)
{
   try
   {
      fs.mkdirSync(ARGS.logDir, { recursive: true });
      logStream = fs.createWriteStream(path.join(ARGS.logDir, 'rstudio-ai-backend.log'), { flags: 'a' });
   }
   catch (e) { /* fall back to stderr only */ }
}

function log(level, msg)
{
   const line = `${new Date().toISOString()} [${level}] ${msg}`;
   process.stderr.write(line + '\n');
   if (logStream) { try { logStream.write(line + '\n'); } catch (e) { /* ignore */ } }
}

// ---------------------------------------------------------------------------
// Configuration (env first, then optional --config file for fallback)
// ---------------------------------------------------------------------------

function loadConfig()
{
   let fileCfg = {};
   if (ARGS.config && fs.existsSync(ARGS.config))
   {
      try
      {
         const raw = JSON.parse(fs.readFileSync(ARGS.config, 'utf8'));
         // Accept either a top-level object or a nested { ai: {...} } / { openai: {...} }
         fileCfg = raw.ai || raw.openai || raw || {};
      }
      catch (e) { log('WARN', `Failed to parse config file ${ARGS.config}: ${e.message}`); }
   }

   const env = process.env;
   const bool = (v, d) => (v === undefined || v === null || v === '') ? d : (v === '1' || v === 'true' || v === true);
   const num = (v, d) => { const n = parseInt(v, 10); return Number.isFinite(n) && n > 0 ? n : d; };

   let baseUrl = env.RSTUDIO_AI_BASE_URL || fileCfg.baseUrl || fileCfg.base_url || 'https://api.openai.com/v1';
   baseUrl = String(baseUrl).replace(/\/+$/, ''); // strip trailing slashes

   return {
      apiKey: env.RSTUDIO_AI_API_KEY || fileCfg.apiKey || fileCfg.api_key || '',
      baseUrl,
      model: env.RSTUDIO_AI_MODEL || fileCfg.model || 'gpt-4o',
      thinking: bool(env.RSTUDIO_AI_THINKING, fileCfg.thinking === undefined ? false : !!fileCfg.thinking),
      interleavedThinking: bool(env.RSTUDIO_AI_INTERLEAVED_THINKING,
                                fileCfg.interleavedThinking === undefined ? false : !!fileCfg.interleavedThinking),
      maxContext: num(env.RSTUDIO_AI_MAX_CONTEXT, num(fileCfg.maxContext, 128000))
   };
}

function isConfigured(cfg)
{
   // A base URL + model is the minimum. Many local servers (Ollama, LM Studio,
   // llama.cpp) need no API key, so the key is not strictly required.
   return !!(cfg.baseUrl && cfg.model);
}

const AUTH_TOKEN = process.env.RSTUDIO_CHAT_AUTH_TOKEN || '';

// ---------------------------------------------------------------------------
// RStudio stdin/stdout JSON-RPC (LSP-style Content-Length framing)
//
// RStudio (C++) sends JSON-RPC responses to the backend via stdin.
// The backend sends JSON-RPC requests to RStudio via stdout.
// Format: "Content-Length: N\r\n\r\n{json body}"
//
// This channel enables calling RStudio capabilities such as:
//   runtime/getDetailedContext  - code + R workspace context
//   workspace/insertAtCursor    - insert generated code at cursor
//   workspace/insertIntoNewFile - create a new document with code
// ---------------------------------------------------------------------------

const pendingRStudioRequests = new Map(); // id -> { resolve, reject, timer }
let rpcIdCounter = 1;
let stdinBuffer = Buffer.alloc(0);

// True once RStudio has sent at least one valid framed message on stdin
// (LSP-style: the client initializes first). Until then we are running
// standalone (or under a test harness) and must not block requests waiting
// for RStudio capabilities that will never answer.
let rstudioConnected = false;

function indexOfCRLFCRLF(buf)
{
   for (let i = 0; i < buf.length - 3; i++)
   {
      if (buf[i] === 0x0d && buf[i + 1] === 0x0a &&
          buf[i + 2] === 0x0d && buf[i + 3] === 0x0a)
         return i;
   }
   return -1;
}

function parseStdinMessages()
{
   for (;;)
   {
      const sep = indexOfCRLFCRLF(stdinBuffer);
      if (sep === -1) break;

      const headerBlock = stdinBuffer.slice(0, sep).toString('utf8');
      const clMatch = /Content-Length:\s*(\d+)/i.exec(headerBlock);
      if (!clMatch)
      {
         stdinBuffer = stdinBuffer.slice(sep + 4);
         continue;
      }

      const contentLength = parseInt(clMatch[1], 10);
      if (contentLength <= 0) { stdinBuffer = stdinBuffer.slice(sep + 4); continue; }

      const bodyStart = sep + 4;
      const bodyEnd = bodyStart + contentLength;
      if (stdinBuffer.length < bodyEnd) break;

      const body = stdinBuffer.slice(bodyStart, bodyEnd).toString('utf8');
      stdinBuffer = stdinBuffer.slice(bodyEnd);

      let msg;
      try { msg = JSON.parse(body); }
      catch (e) { log('WARN', `Failed to parse stdin JSON-RPC: ${e.message}`); continue; }

      // A valid frame means RStudio is on the other end of the pipe.
      if (!rstudioConnected)
      {
         rstudioConnected = true;
         log('INFO', 'RStudio JSON-RPC channel connected');
      }

      // Match the response to a pending callRStudio() promise
      if (msg.id !== undefined && msg.id !== null)
      {
         const pending = pendingRStudioRequests.get(msg.id);
         if (pending)
         {
            pendingRStudioRequests.delete(msg.id);
            clearTimeout(pending.timer);
            if (msg.error)
               pending.reject(new Error(`RStudio RPC error: ${JSON.stringify(msg.error)}`));
            else
               pending.resolve(msg.result);
         }
      }
   }
}

// Arm the stdin reader only when running under RStudio (stdin is a pipe).
// In standalone/test mode stdin may not exist or may be a TTY.
if (process.stdin && !process.stdin.isTTY)
{
   process.stdin.on('data', (chunk) =>
   {
      stdinBuffer = Buffer.concat([stdinBuffer, chunk]);
      parseStdinMessages();
   });
   process.stdin.resume();
}

// Write a JSON-RPC request to stdout (to RStudio) and return a Promise that
// resolves with the result or rejects on error/timeout.
function callRStudio(method, params, timeoutMs)
{
   timeoutMs = timeoutMs || 5000;
   return new Promise((resolve, reject) =>
   {
      const id = rpcIdCounter++;
      const timer = setTimeout(() =>
      {
         if (pendingRStudioRequests.has(id))
         {
            pendingRStudioRequests.delete(id);
            reject(new Error(`RStudio RPC timeout: ${method}`));
         }
      }, timeoutMs);

      pendingRStudioRequests.set(id, { resolve, reject, timer });

      const body = JSON.stringify({ jsonrpc: '2.0', id, method, params: params || {} });
      const frame = `Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`;
      try { process.stdout.write(frame); }
      catch (e)
      {
         pendingRStudioRequests.delete(id);
         clearTimeout(timer);
         reject(new Error(`Failed to write to stdout: ${e.message}`));
      }
   });
}

// Format the getDetailedContext response into a compact system-prompt addendum.
function formatRStudioContext(ctx)
{
   if (!ctx || typeof ctx !== 'object') return null;
   const lines = [];

   if (ctx.session)
   {
      const s = ctx.session;
      lines.push(`R ${s.version || '?'} | session ${(s.sessionId || '').slice(0, 8)}`);
   }

   if (Array.isArray(ctx.openFiles) && ctx.openFiles.length)
   {
      const fileParts = ctx.openFiles.map((f) =>
      {
         let name = f.uri ? f.uri.replace(/^.*[/\\]/, '') : 'file';
         if (f.uri && f.uri.startsWith('untitled:')) name = 'Untitled';
         let info = f.isActiveEditor ? `**${name}** (active` : name;
         if (f.isActiveEditor)
         {
            if (Array.isArray(f.selections) && f.selections.length)
               info += `, line ${(f.selections[0].line || 0) + 1}`;
            info += ')';
         }
         if (f.isModified) info += '[+]';
         return info;
      });
      lines.push(`Files: ${fileParts.join(', ')}`);
   }

   if (ctx.session && Array.isArray(ctx.session.variables) && ctx.session.variables.length)
   {
      const vars = ctx.session.variables.slice(0, 15).map((v) => `${v.name} (${v.type})`);
      lines.push(`Workspace: ${vars.join(', ')}`);
      const meta = ctx.session.variablesMeta;
      if (meta && meta.totalCount > 15)
         lines.push(`  ...${meta.totalCount - 15} more variables`);
   }

   if (ctx.platformInfo && ctx.platformInfo.currentDate)
      lines.push(`Date: ${ctx.platformInfo.currentDate}`);

   return lines.length ? lines.join('\n') : null;
}

// ---------------------------------------------------------------------------
// Pi-style agent loop: tools the model can call to drive the R session.
//
// Modeled on the Pi coding agent (github.com/earendil-works/pi), whose agent
// gives the model a small set of tools (read / write / edit / bash) and loops
// until the model stops calling them. Here the tools are mapped onto RStudio's
// live R kernel instead of the filesystem:
//
//   run_r_code     - execute R in the user's session (the "bash" analog)
//   inspect_data   - read-only structure/preview of an object or data frame
//   read_workspace - list global-environment variables and open files
//
// Tools are only offered to the model when RStudio is connected on the
// JSON-RPC channel (so they can actually run); standalone/test chat stays a
// plain completion unless a peer answers runtime/executeCode.
// ---------------------------------------------------------------------------

const MAX_TOOL_ITERATIONS = 8;

const R_TOOLS = [
   {
      type: 'function',
      function: {
         name: 'run_r_code',
         description:
            'Execute R code in the user\'s live R session and return console output. ' +
            'Use for computation, data manipulation, fitting models, plotting, and ' +
            'loading or transforming data frames. Destructive operations (deleting ' +
            'files, clearing the workspace, shell commands, installing packages, ' +
            'writing to disk or databases) require explicit user confirmation, so ' +
            'prefer non-destructive code and explain side effects.',
         parameters: {
            type: 'object',
            properties: {
               code: { type: 'string', description: 'The R code to execute.' }
            },
            required: ['code']
         }
      }
   },
   {
      type: 'function',
      function: {
         name: 'inspect_data',
         description:
            'Inspect an existing R object or data frame: its structure (str), ' +
            'dimensions, and the first rows (head). Read-only and always safe.',
         parameters: {
            type: 'object',
            properties: {
               name: { type: 'string', description: 'Name of the R object/data frame to inspect.' }
            },
            required: ['name']
         }
      }
   },
   {
      type: 'function',
      function: {
         name: 'read_workspace',
         description:
            'List the variables in the R global environment and the files open in ' +
            'the editor. Read-only; use it to discover what data is available.',
         parameters: { type: 'object', properties: {} }
      }
   }
];

// Classify R code for destructive side effects.
// Returns { level: 'allow' | 'confirm' | 'block', reason }.
//   block   - never run automatically (catastrophic / irreversible system harm)
//   confirm - run only after the user approves in the UI
//   allow   - run immediately
function classifyRCode(code)
{
   const c = String(code || '');

   const blockPatterns = [
      { re: /system2?\s*\(\s*["'`][^"'`]*\brm\s+-[rf]/i, reason: 'shell "rm -rf"' },
      { re: /unlink\s*\([^)]*recursive\s*=\s*(?:T|TRUE)\b/i, reason: 'recursive unlink() (mass file deletion)' },
      { re: /system2?\s*\(\s*["'`]\s*(?:sudo|mkfs|dd|shutdown|reboot|:\s*\(\s*\)\s*\{)/i, reason: 'dangerous shell command' }
   ];
   for (const p of blockPatterns)
      if (p.re.test(c)) return { level: 'block', reason: p.reason };

   const confirmPatterns = [
      { re: /\bunlink\s*\(/, reason: 'deletes files (unlink)' },
      { re: /\bfile\.remove\s*\(/, reason: 'deletes files (file.remove)' },
      { re: /\bfile\.rename\s*\(/, reason: 'renames or moves files' },
      { re: /\brm\s*\(\s*list\s*=\s*ls\s*\(/, reason: 'clears the entire R workspace' },
      { re: /\bsystem2?\s*\(/, reason: 'runs a shell command' },
      { re: /\bshell\s*\(/, reason: 'runs a shell command' },
      { re: /\binstall\.packages\s*\(/, reason: 'installs packages' },
      { re: /\bremove\.packages\s*\(/, reason: 'removes packages' },
      { re: /\b(?:write\.csv|write\.csv2|write\.table|writeLines|saveRDS|save|fwrite|write_csv|write_rds|ggsave)\s*\(/, reason: 'writes files to disk' },
      { re: /\bdownload\.file\s*\(/, reason: 'downloads from the network' },
      { re: /\b(?:dbExecute|dbSendStatement|dbRemoveTable|dbWriteTable)\s*\(/, reason: 'modifies a database' },
      { re: /\b(?:DROP|DELETE|TRUNCATE)\s+(?:TABLE|FROM|INTO|DATABASE)?/i, reason: 'destructive SQL statement' },
      { re: /\b(?:q|quit)\s*\(/, reason: 'quits the R session' },
      { re: /\bsetwd\s*\(/, reason: 'changes the working directory' }
   ];
   for (const p of confirmPatterns)
      if (p.re.test(c)) return { level: 'confirm', reason: p.reason };

   return { level: 'allow', reason: '' };
}

// A valid R identifier (used to guard inspect_data against code injection).
const R_IDENTIFIER = /^[a-zA-Z.][a-zA-Z0-9._]*$/;

// Ask the client to approve a destructive tool call. Resolves true/false.
// Pending requests are tracked per-connection on ws.pendingConfirms and
// resolved when the client sends a matching { type: 'confirmResponse' }.
function requestConfirmation(ws, requestId, callId, tool, code, reason)
{
   return new Promise((resolve) =>
   {
      const timer = setTimeout(() =>
      {
         if (ws.pendingConfirms && ws.pendingConfirms.has(callId))
         {
            ws.pendingConfirms.delete(callId);
            resolve(false); // default-deny on timeout
         }
      }, 120000);
      ws.pendingConfirms.set(callId, { resolve, timer });
      ws.sendJSON({ type: 'confirmRequired', requestId, callId, tool, code, reason });
   });
}

// Render a runtime/executeCode result into text for the model.
function formatExecResult(res)
{
   if (res == null) return '(no output)';
   if (typeof res === 'string') return res || '(no output)';
   const parts = [];
   if (res.output) parts.push(String(res.output));
   if (res.error) parts.push('Error: ' + String(res.error));
   if (!parts.length && res.result !== undefined) parts.push(String(res.result));
   return parts.length ? parts.join('\n') : '(no output)';
}

// Execute a single tool call (with guardrails) and return a string result
// to feed back to the model. Streams toolCall/toolResult events to the client.
async function executeToolCall(ws, requestId, call)
{
   const name = call.function && call.function.name;
   let args = {};
   try { args = JSON.parse((call.function && call.function.arguments) || '{}'); }
   catch (e) { return `Could not parse tool arguments: ${e.message}`; }

   if (name === 'run_r_code')
   {
      const code = typeof args.code === 'string' ? args.code : '';
      if (!code.trim()) return 'No code was provided.';

      const verdict = classifyRCode(code);
      if (verdict.level === 'block')
      {
         ws.sendJSON({ type: 'toolResult', requestId, callId: call.id, tool: name, ok: false, blocked: true, reason: verdict.reason });
         return `BLOCKED by the safety policy: ${verdict.reason}. The code was NOT executed. Do not retry this; propose a safer approach.`;
      }
      if (verdict.level === 'confirm')
      {
         const approved = await requestConfirmation(ws, requestId, call.id, name, code, verdict.reason);
         if (!approved)
         {
            ws.sendJSON({ type: 'toolResult', requestId, callId: call.id, tool: name, ok: false, denied: true, reason: verdict.reason });
            return `The user DECLINED to run this code (${verdict.reason}). It was NOT executed. Suggest a safer alternative or ask how to proceed.`;
         }
      }

      ws.sendJSON({ type: 'toolCall', requestId, callId: call.id, tool: name, code });
      try
      {
         const res = await callRStudio('runtime/executeCode', { code }, 120000);
         const out = formatExecResult(res);
         ws.sendJSON({ type: 'toolResult', requestId, callId: call.id, tool: name, ok: true });
         return out.slice(0, 16000);
      }
      catch (e)
      {
         ws.sendJSON({ type: 'toolResult', requestId, callId: call.id, tool: name, ok: false, message: e.message });
         return `Execution failed: ${e.message}`;
      }
   }

   if (name === 'inspect_data')
   {
      const objName = typeof args.name === 'string' ? args.name.trim() : '';
      if (!R_IDENTIFIER.test(objName))
         return `'${objName}' is not a valid R object name.`;
      ws.sendJSON({ type: 'toolCall', requestId, callId: call.id, tool: name, target: objName });
      const probe =
         `cat("class:", paste(class(${objName}), collapse=', '), "\\n"); ` +
         `if (is.data.frame(${objName})) cat("dim:", paste(dim(${objName}), collapse=' x '), "\\n"); ` +
         `cat("--- str ---\\n"); utils::str(${objName}); ` +
         `cat("--- head ---\\n"); print(utils::head(${objName}))`;
      try
      {
         const res = await callRStudio('runtime/executeCode', { code: probe }, 30000);
         ws.sendJSON({ type: 'toolResult', requestId, callId: call.id, tool: name, ok: true });
         return formatExecResult(res).slice(0, 16000);
      }
      catch (e)
      {
         ws.sendJSON({ type: 'toolResult', requestId, callId: call.id, tool: name, ok: false, message: e.message });
         return `Could not inspect '${objName}': ${e.message}`;
      }
   }

   if (name === 'read_workspace')
   {
      ws.sendJSON({ type: 'toolCall', requestId, callId: call.id, tool: name });
      try
      {
         const ctx = await callRStudio('runtime/getDetailedContext', {}, 8000);
         ws.sendJSON({ type: 'toolResult', requestId, callId: call.id, tool: name, ok: true });
         return formatRStudioContext(ctx) || '(empty workspace)';
      }
      catch (e)
      {
         ws.sendJSON({ type: 'toolResult', requestId, callId: call.id, tool: name, ok: false, message: e.message });
         return `Could not read workspace: ${e.message}`;
      }
   }

   return `Unknown tool: ${name}`;
}

// ---------------------------------------------------------------------------
// Minimal WebSocket server (RFC 6455), no external dependencies
// ---------------------------------------------------------------------------

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function computeAcceptKey(key)
{
   return crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
}

// Encode a server->client frame (unmasked). opcode 0x1 = text, 0x8 = close,
// 0x9 = ping, 0xA = pong.
function encodeFrame(opcode, payload)
{
   const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, 'utf8');
   const len = data.length;
   let header;
   if (len < 126)
   {
      header = Buffer.alloc(2);
      header[1] = len;
   }
   else if (len < 65536)
   {
      header = Buffer.alloc(4);
      header[1] = 126;
      header.writeUInt16BE(len, 2);
   }
   else
   {
      header = Buffer.alloc(10);
      header[1] = 127;
      // Node supports BigInt writes; lengths here never exceed 2^53.
      header.writeUInt32BE(Math.floor(len / 0x100000000), 2);
      header.writeUInt32BE(len >>> 0, 6);
   }
   header[0] = 0x80 | (opcode & 0x0f); // FIN + opcode
   return Buffer.concat([header, data]);
}

class WebSocketConnection
{
   constructor(socket)
   {
      this.socket = socket;
      this.buffer = Buffer.alloc(0);
      this.closed = false;
      this.fragments = [];        // accumulated continuation payloads
      this.fragmentOpcode = null; // opcode of the message being assembled
      this.handlers = { message: [], close: [] };

      socket.on('data', (chunk) => this._onData(chunk));
      socket.on('close', () => this._fireClose());
      socket.on('error', () => this._fireClose());
   }

   on(event, fn) { if (this.handlers[event]) this.handlers[event].push(fn); return this; }

   off(event, fn)
   {
      const list = this.handlers[event];
      if (!list) return this;
      const idx = list.indexOf(fn);
      if (idx !== -1) list.splice(idx, 1);
      return this;
   }

   _fireClose()
   {
      if (this.closed) return;
      this.closed = true;
      this.handlers.close.forEach((fn) => { try { fn(); } catch (e) { /* ignore */ } });
   }

   sendText(str) { this._send(0x1, Buffer.from(str, 'utf8')); }
   sendJSON(obj) { this.sendText(JSON.stringify(obj)); }

   _send(opcode, payload)
   {
      if (this.closed || this.socket.destroyed) return;
      try { this.socket.write(encodeFrame(opcode, payload)); }
      catch (e) { this._fireClose(); }
   }

   close(code = 1000)
   {
      if (this.closed) return;
      const payload = Buffer.alloc(2);
      payload.writeUInt16BE(code, 0);
      this._send(0x8, payload);
      try { this.socket.end(); } catch (e) { /* ignore */ }
      this._fireClose();
   }

   _onData(chunk)
   {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      // Parse as many complete frames as are buffered.
      for (;;)
      {
         const frame = this._parseFrame();
         if (!frame) break;
         this._handleFrame(frame);
      }
   }

   // Returns { fin, opcode, payload } and advances the buffer, or null if a
   // complete frame is not yet available.
   _parseFrame()
   {
      const buf = this.buffer;
      if (buf.length < 2) return null;

      const fin = (buf[0] & 0x80) !== 0;
      const opcode = buf[0] & 0x0f;
      const masked = (buf[1] & 0x80) !== 0;
      let len = buf[1] & 0x7f;
      let offset = 2;

      if (len === 126)
      {
         if (buf.length < offset + 2) return null;
         len = buf.readUInt16BE(offset);
         offset += 2;
      }
      else if (len === 127)
      {
         if (buf.length < offset + 8) return null;
         const hi = buf.readUInt32BE(offset);
         const lo = buf.readUInt32BE(offset + 4);
         len = hi * 0x100000000 + lo;
         offset += 8;
      }

      let maskKey = null;
      if (masked)
      {
         if (buf.length < offset + 4) return null;
         maskKey = buf.slice(offset, offset + 4);
         offset += 4;
      }

      if (buf.length < offset + len) return null;

      let payload = buf.slice(offset, offset + len);
      if (masked && maskKey)
      {
         const unmasked = Buffer.alloc(len);
         for (let i = 0; i < len; i++) unmasked[i] = payload[i] ^ maskKey[i & 3];
         payload = unmasked;
      }

      this.buffer = buf.slice(offset + len);
      return { fin, opcode, payload };
   }

   _handleFrame(frame)
   {
      const { fin, opcode, payload } = frame;
      switch (opcode)
      {
         case 0x0: // continuation
            this.fragments.push(payload);
            if (fin) this._deliverMessage();
            break;
         case 0x1: // text
         case 0x2: // binary (treated as text payloads here)
            if (fin)
            {
               this._deliverText(payload);
            }
            else
            {
               this.fragmentOpcode = opcode;
               this.fragments = [payload];
            }
            break;
         case 0x8: // close
            this.close();
            break;
         case 0x9: // ping
            this._send(0xA, payload);
            break;
         case 0xA: // pong
            break;
         default:
            this.close(1002);
      }
   }

   _deliverMessage()
   {
      const full = Buffer.concat(this.fragments);
      this.fragments = [];
      this.fragmentOpcode = null;
      this._deliverText(full);
   }

   _deliverText(payload)
   {
      const str = payload.toString('utf8');
      this.handlers.message.forEach((fn) => { try { fn(str); } catch (e) { log('ERROR', `message handler: ${e.stack || e}`); } });
   }
}

// ---------------------------------------------------------------------------
// Auth: extract token from query string or cookie, compare in constant time
// ---------------------------------------------------------------------------

function extractToken(req)
{
   try
   {
      const u = new URL(req.url, 'http://localhost');
      const q = u.searchParams.get('token');
      if (q) return q;
   }
   catch (e) { /* ignore */ }

   const cookie = req.headers['cookie'] || '';
   const m = cookie.match(/(?:^|;\s*)posit-assistant-auth=([^;]+)/);
   if (m) return decodeURIComponent(m[1]);

   // Some clients pass the token via the WebSocket subprotocol header.
   const proto = req.headers['sec-websocket-protocol'];
   if (proto) return proto.split(',')[0].trim();

   return '';
}

function tokenOk(provided)
{
   if (!AUTH_TOKEN) return true; // no token configured (dev / direct run)
   if (!provided) return false;
   const a = Buffer.from(provided);
   const b = Buffer.from(AUTH_TOKEN);
   return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ---------------------------------------------------------------------------
// Static file serving (client UI). In production RStudio serves these too,
// but serving them here keeps the backend independently runnable/testable.
// ---------------------------------------------------------------------------

const CLIENT_DIR = path.resolve(__dirname, '..', 'client');
const CONTENT_TYPES = {
   '.html': 'text/html; charset=utf-8',
   '.js': 'application/javascript; charset=utf-8',
   '.css': 'text/css; charset=utf-8',
   '.json': 'application/json; charset=utf-8',
   '.svg': 'image/svg+xml',
   '.ico': 'image/x-icon'
};

function serveStatic(req, res)
{
   let urlPath;
   try { urlPath = new URL(req.url, 'http://localhost').pathname; }
   catch (e) { urlPath = '/'; }

   if (urlPath === '/' || urlPath === '') urlPath = '/index.html';

   // Prevent path traversal.
   const resolved = path.resolve(CLIENT_DIR, '.' + urlPath);
   if (!resolved.startsWith(CLIENT_DIR))
   {
      res.writeHead(403); res.end('Forbidden'); return;
   }

   fs.readFile(resolved, (err, data) =>
   {
      if (err)
      {
         res.writeHead(404, { 'Content-Type': 'text/plain' });
         res.end('Not found');
         return;
      }
      const ext = path.extname(resolved).toLowerCase();
      res.writeHead(200, { 'Content-Type': CONTENT_TYPES[ext] || 'application/octet-stream' });
      res.end(data);
   });
}

// ---------------------------------------------------------------------------
// Conversation -> OpenAI-compatible request, with context trimming
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT =
   'You are a helpful AI programming assistant embedded in the RStudio IDE. ' +
   'You help users with R, Python, data analysis, statistics, and general ' +
   'programming. When you include code, use fenced code blocks and specify the ' +
   'language. Be concise and accurate.';

// Rough token estimate (~4 chars/token) used only to keep the request under
// the configured context window; exact tokenization is provider-specific.
function estimateTokens(text)
{
   return Math.ceil((text ? text.length : 0) / 4) + 4;
}

function buildMessages(history, cfg, contextStr)
{
   let systemContent = SYSTEM_PROMPT;
   if (contextStr)
      systemContent += '\n\n## Current RStudio Context\n' + contextStr;

   const system = { role: 'system', content: systemContent };

   // Reserve part of the window for the model's reply.
   const reserve = Math.min(Math.floor(cfg.maxContext / 4), 4096);
   let budget = Math.max(cfg.maxContext - reserve - estimateTokens(systemContent), 512);

   const kept = [];
   for (let i = history.length - 1; i >= 0; i--)
   {
      const msg = history[i];
      if (!msg || !msg.role || typeof msg.content !== 'string') continue;
      const cost = estimateTokens(msg.content);
      if (cost > budget && kept.length > 0) break;
      budget -= cost;
      kept.push({ role: msg.role, content: msg.content });
   }
   kept.reverse();
   return [system, ...kept];
}

function buildRequestBody(messages, cfg, tools)
{
   const body = {
      model: cfg.model,
      messages,
      stream: true
   };
   if (cfg.thinking)
   {
      // Standard OpenAI reasoning control; supported by o-series and many
      // OpenAI-compatible servers. Harmless hint for others.
      body.reasoning_effort = 'medium';
   }
   if (tools && tools.length)
   {
      body.tools = tools;
      body.tool_choice = 'auto';
   }
   return body;
}

// Run a single provider turn: stream text/thinking deltas to the client and
// assemble any tool calls the model emits. Does NOT send a 'done' event --
// the caller decides whether the agent loop continues (tool calls) or ends.
// Returns { assistantText, toolCalls, error }.
async function runProviderTurn(ws, requestId, messages, cfg, tools, controller)
{
   const url = cfg.baseUrl + '/chat/completions';
   const headers = { 'Content-Type': 'application/json' };
   if (cfg.apiKey) headers['Authorization'] = 'Bearer ' + cfg.apiKey;

   // Per-turn streaming state for filtering embedded <thinking> XML tags.
   // Some OpenAI-compatible providers (e.g. Claude via LiteLLM without tag
   // stripping) include thinking in <thinking>...</thinking> blocks within
   // delta.content instead of delta.reasoning_content.
   let inThinkingTag = false;
   let partialTagBuf = '';

   function processContentChunk(text)
   {
      let textOut = '';
      let thinkingOut = '';
      let combined = partialTagBuf + text;
      partialTagBuf = '';

      while (combined.length > 0)
      {
         if (inThinkingTag)
         {
            const closeIdx = combined.indexOf('</thinking>');
            if (closeIdx !== -1)
            {
               thinkingOut += combined.slice(0, closeIdx);
               combined = combined.slice(closeIdx + '</thinking>'.length);
               inThinkingTag = false;
            }
            else
            {
               thinkingOut += combined;
               combined = '';
            }
         }
         else
         {
            const openIdx = combined.indexOf('<thinking>');
            if (openIdx !== -1)
            {
               textOut += combined.slice(0, openIdx);
               combined = combined.slice(openIdx + '<thinking>'.length);
               inThinkingTag = true;
            }
            else
            {
               // Check for a partial '<thinking>' tag at the tail.
               const maxLen = '<thinking>'.length - 1;
               let partialIdx = -1;
               for (let i = Math.max(0, combined.length - maxLen); i < combined.length; i++)
               {
                  if ('<thinking>'.startsWith(combined.slice(i)))
                  {
                     partialIdx = i;
                     break;
                  }
               }
               if (partialIdx !== -1)
               {
                  textOut += combined.slice(0, partialIdx);
                  partialTagBuf = combined.slice(partialIdx);
               }
               else
               {
                  textOut += combined;
               }
               combined = '';
            }
         }
      }

      return { text: textOut, thinking: thinkingOut };
   }

   let assistantText = '';
   const toolCallsAcc = [];

   let reader = null;
   try
   {
      let resp;
      try
      {
         resp = await fetch(url, {
            method: 'POST',
            headers,
            body: JSON.stringify(buildRequestBody(messages, cfg, tools)),
            signal: controller.signal
         });
      }
      catch (e)
      {
         ws.sendJSON({ type: 'error', requestId, message: `Request to ${url} failed: ${e.message}` });
         return { error: true, toolCalls: [] };
      }

      if (!resp.ok)
      {
         let detail = '';
         try { detail = await resp.text(); } catch (e) { /* ignore */ }
         ws.sendJSON({ type: 'error', requestId, message: `Provider returned ${resp.status} ${resp.statusText}: ${detail.slice(0, 1000)}` });
         return { error: true, toolCalls: [] };
      }

      reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let sseBuffer = '';
      let sawDone = false;

      const dispatchData = (data) =>
      {
         if (data === '[DONE]') { sawDone = true; return false; }
         let json;
         try { json = JSON.parse(data); } catch (e) { return true; }
         const choice = json.choices && json.choices[0];
         if (!choice) return true;
         const delta = choice.delta || {};

         // Reasoning content via dedicated fields (OpenAI o-series, DeepSeek, etc.)
         const reasoning = delta.reasoning_content || delta.reasoning;
         if (reasoning)
            ws.sendJSON({ type: 'thinking', requestId, content: reasoning });

         if (typeof delta.content === 'string' && delta.content.length)
         {
            const { text, thinking } = processContentChunk(delta.content);
            if (thinking)
               ws.sendJSON({ type: 'thinking', requestId, content: thinking });
            if (text)
            {
               assistantText += text;
               ws.sendJSON({ type: 'delta', requestId, content: text });
            }
         }

         // Assemble streamed tool calls (OpenAI sends them in fragments keyed
         // by index: id/name arrive first, arguments stream in pieces).
         if (Array.isArray(delta.tool_calls))
         {
            for (const d of delta.tool_calls)
            {
               const idx = typeof d.index === 'number' ? d.index : 0;
               if (!toolCallsAcc[idx])
                  toolCallsAcc[idx] = { id: '', type: 'function', function: { name: '', arguments: '' } };
               const slot = toolCallsAcc[idx];
               if (d.id) slot.id = d.id;
               if (d.type) slot.type = d.type;
               if (d.function)
               {
                  if (d.function.name) slot.function.name += d.function.name;
                  if (typeof d.function.arguments === 'string')
                     slot.function.arguments += d.function.arguments;
               }
            }
         }
         return true;
      };

      for (;;)
      {
         const { value, done } = await reader.read();
         if (done) break;
         sseBuffer += decoder.decode(value, { stream: true });

         let nl;
         while ((nl = sseBuffer.indexOf('\n')) !== -1)
         {
            let line = sseBuffer.slice(0, nl);
            sseBuffer = sseBuffer.slice(nl + 1);
            line = line.replace(/\r$/, '').trim();
            if (!line || line.startsWith(':')) continue;        // comment / keep-alive
            if (line.startsWith('data:'))
            {
               const data = line.slice(5).trim();
               if (!dispatchData(data)) break;
            }
         }
         if (sawDone) break;
      }

      const toolCalls = toolCallsAcc.filter((t) => t && t.function && t.function.name);
      for (const t of toolCalls) if (!t.id) t.id = 'call_' + (rpcIdCounter++);
      return { assistantText, toolCalls };
   }
   catch (e)
   {
      if (!controller.signal.aborted)
         ws.sendJSON({ type: 'error', requestId, message: `Stream error: ${e.message}` });
      return { error: true, toolCalls: [] };
   }
   finally
   {
      // Release the upstream response body so no socket is left dangling.
      if (reader)
      {
         try { await reader.cancel(); } catch (e) { /* ignore */ }
      }
   }
}

// Drive a full agent turn: fetch context, then loop provider turns and tool
// executions (Pi-style) until the model stops calling tools or we hit the cap.
async function streamCompletion(ws, requestId, history, cfg)
{
   // Fetch RStudio context (open files, R workspace, cursor position).
   // Only attempt this when RStudio is actually connected; otherwise we would
   // block on a request that never gets answered. Fail gracefully either way
   // -- missing context is better than a broken chat.
   let contextStr = null;
   if (rstudioConnected)
   {
      try
      {
         const ctx = await callRStudio('runtime/getDetailedContext', {}, 4000);
         contextStr = formatRStudioContext(ctx);
      }
      catch (e)
      {
         log('DEBUG', `Could not fetch RStudio context: ${e.message}`);
      }
   }

   // Tools can only run when RStudio is connected to execute them. Without a
   // peer, fall back to plain chat (preserves standalone/test behavior).
   const tools = rstudioConnected ? R_TOOLS : null;
   const messages = buildMessages(history, cfg, contextStr);

   const controller = new AbortController();
   const onClose = () => controller.abort();
   ws.on('close', onClose);

   try
   {
      for (let iter = 0; iter < MAX_TOOL_ITERATIONS; iter++)
      {
         const turn = await runProviderTurn(ws, requestId, messages, cfg, tools, controller);
         if (turn.error) return;                 // error already reported to client
         if (controller.signal.aborted) return;  // socket closed mid-turn

         if (!turn.toolCalls.length)
         {
            ws.sendJSON({ type: 'done', requestId });
            return;
         }

         // Record the assistant's tool-call message, then run each tool and
         // feed its result back as a tool message for the next turn.
         messages.push({ role: 'assistant', content: turn.assistantText || null, tool_calls: turn.toolCalls });
         for (const call of turn.toolCalls)
         {
            const result = await executeToolCall(ws, requestId, call);
            messages.push({ role: 'tool', tool_call_id: call.id, content: result });
            if (controller.signal.aborted) return;
         }
      }

      // Safety valve: don't loop forever if the model keeps calling tools.
      ws.sendJSON({ type: 'delta', requestId, content: '\n\n_(Reached the tool-call limit; stopping here.)_' });
      ws.sendJSON({ type: 'done', requestId });
   }
   catch (e)
   {
      if (!controller.signal.aborted)
         ws.sendJSON({ type: 'error', requestId, message: `Agent error: ${e.message}` });
   }
   finally
   {
      // Detach the per-request close handler (otherwise handlers accumulate
      // one closure per turn on a long-lived socket).
      ws.off('close', onClose);
   }
}

// ---------------------------------------------------------------------------
// WebSocket message protocol
// ---------------------------------------------------------------------------

function handleConnection(ws)
{
   const cfg = loadConfig(); // re-read per connection so pref changes take effect

   // Outstanding destructive-action confirmations, keyed by tool-call id.
   ws.pendingConfirms = new Map();

   ws.sendJSON({
      type: 'ready',
      configured: isConfigured(cfg),
      model: cfg.model,
      baseUrl: cfg.baseUrl,
      thinking: cfg.thinking,
      interleavedThinking: cfg.interleavedThinking,
      maxContext: cfg.maxContext
   });

   ws.on('message', (raw) =>
   {
      let msg;
      try { msg = JSON.parse(raw); }
      catch (e) { ws.sendJSON({ type: 'error', message: 'Invalid JSON' }); return; }

      if (msg.type === 'ping') { ws.sendJSON({ type: 'pong' }); return; }

      // User's approve/deny decision for a guarded (destructive) tool call.
      if (msg.type === 'confirmResponse')
      {
         const pending = ws.pendingConfirms.get(msg.callId);
         if (pending)
         {
            ws.pendingConfirms.delete(msg.callId);
            clearTimeout(pending.timer);
            pending.resolve(!!msg.approved);
         }
         return;
      }

      if (msg.type === 'chat')
      {
         const current = loadConfig();
         if (!isConfigured(current))
         {
            ws.sendJSON({ type: 'error', requestId: msg.requestId,
               message: 'The AI backend is not configured. Open AI settings and set a base URL and model.' });
            return;
         }
         const history = Array.isArray(msg.messages) ? msg.messages : [];
         streamCompletion(ws, msg.requestId, history, current);
         return;
      }

      // Insert generated code at the cursor position in the focused editor.
      if (msg.type === 'insertAtCursor')
      {
         const code = typeof msg.code === 'string' ? msg.code : '';
         if (!code) { ws.sendJSON({ type: 'insertResult', success: false, message: 'No code provided' }); return; }
         callRStudio('workspace/insertAtCursor', { content: code }, 5000)
            .then((result) =>
            {
               ws.sendJSON({ type: 'insertResult', success: !!(result && result.success), action: 'cursor' });
            })
            .catch((e) =>
            {
               ws.sendJSON({ type: 'insertResult', success: false, message: e.message, action: 'cursor' });
            });
         return;
      }

      // Insert generated code into a new untitled document.
      if (msg.type === 'insertIntoNewFile')
      {
         const code = typeof msg.code === 'string' ? msg.code : '';
         const language = typeof msg.language === 'string' ? msg.language : '';
         if (!code) { ws.sendJSON({ type: 'insertResult', success: false, message: 'No code provided' }); return; }
         callRStudio('workspace/insertIntoNewFile', { content: code, languageId: language }, 5000)
            .then((result) =>
            {
               ws.sendJSON({ type: 'insertResult', success: !!(result && result.success), action: 'newfile' });
            })
            .catch((e) =>
            {
               ws.sendJSON({ type: 'insertResult', success: false, message: e.message, action: 'newfile' });
            });
         return;
      }
   });
}

// ---------------------------------------------------------------------------
// HTTP server + WebSocket upgrade
// ---------------------------------------------------------------------------

const server = http.createServer((req, res) =>
{
   let pathname;
   try { pathname = new URL(req.url, 'http://localhost').pathname; }
   catch (e) { pathname = req.url; }

   if (pathname === '/healthz')
   {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
      return;
   }

   // Static client (also served by RStudio in production).
   serveStatic(req, res);
});

server.on('upgrade', (req, socket) =>
{
   let pathname;
   try { pathname = new URL(req.url, 'http://localhost').pathname; }
   catch (e) { pathname = req.url || ''; }

   // Accept the documented endpoint and a couple of tolerant variants.
   const okPath = pathname === '/ai-chat/ws' || pathname === '/ai-chat' ||
                  pathname === '/ws' || pathname === '/';
   const key = req.headers['sec-websocket-key'];

   if (!okPath || !key)
   {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      socket.destroy();
      return;
   }

   if (!tokenOk(extractToken(req)))
   {
      log('WARN', 'Rejected WebSocket connection: bad or missing auth token');
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
   }

   const acceptKey = computeAcceptKey(key);
   socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${acceptKey}\r\n\r\n`);

   const ws = new WebSocketConnection(socket);
   handleConnection(ws);
});

server.listen(ARGS.port, ARGS.host, () =>
{
   const addr = server.address();
   const cfg = loadConfig();
   log('INFO', `RStudio AI backend listening on ${ARGS.host}:${addr.port} ` +
       `(mode=${ARGS.serverMode ? 'server' : 'desktop'}, configured=${isConfigured(cfg)}, ` +
       `model=${cfg.model}, baseUrl=${cfg.baseUrl})`);
   // Emit a machine-readable port marker to stderr (used by tests/standalone tools).
   // Stdout is reserved for the LSP-style JSON-RPC channel to RStudio.
   process.stderr.write(`RSTUDIO_AI_BACKEND_LISTENING ${addr.port}\n`);
});

process.on('SIGTERM', () => { try { server.close(); } catch (e) {} process.exit(0); });
process.on('SIGINT', () => { try { server.close(); } catch (e) {} process.exit(0); });
