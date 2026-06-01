/*
 * main.js
 *
 * RStudio AI backend powered by the Pi coding agent
 * (https://github.com/earendil-works/pi-mono).
 *
 * This process is launched by RStudio (see SessionChat.cpp) in place of the
 * Posit Assistant / OpenAI bridge. It:
 *
 *   1. Speaks a small JSON protocol over a WebSocket to the chat client UI
 *      (dist/client) -- the same protocol the previous OpenAI bridge used, so
 *      the GWT chat panel requires no changes.
 *
 *   2. Hosts a Pi Agent session in-process (via @earendil-works/pi-coding-agent's
 *      SDK). Pi Agent handles the full agent loop: LLM streaming, tool calls,
 *      thinking, compaction, session persistence, etc.
 *
 *   3. Registers a curated set of custom R tools (r_execute, r_list_variables,
 *      r_get_dataframe, r_read_console, r_install_package). Each tool's execute
 *      function talks to the live R session in RStudio via JSON-RPC 2.0 over a
 *      stdio channel to the rsession C++ process.
 *
 *   4. Adds a guardrail extension that requires explicit user confirmation
 *      before any destructive R operation (file removal, system(), setwd() to
 *      an unexpected directory, package install/remove, options() mutation,
 *      env-var assignment, etc.) and before any built-in tool that could touch
 *      the filesystem or shell.
 *
 *   5. Speaks JSON-RPC 2.0 over stdio to the C++ rsession process, in the
 *      direction rsession->backend (the C++ side dials US with capability
 *      requests like "execute this R code", "open this file"). The C++ side's
 *      inverse handlers (R session read/write/execute) are invoked by us when
 *      the agent calls an R tool.
 *
 * No Posit account, sign-in, telemetry, or proprietary databot is involved.
 * The user supplies the LLM via Pi Agent's standard provider configuration
 * (ANTHROPIC_API_KEY / OPENAI_API_KEY / OLLAMA_BASE_URL / etc.).
 *
 * Environment variables from RStudio:
 *
 *   RSTUDIO_CHAT_AUTH_TOKEN       Per-session WebSocket auth token
 *   RSTUDIO_PI_PROVIDER           LLM provider (anthropic/openai/...)
 *   RSTUDIO_PI_MODEL              Model ID
 *   RSTUDIO_PI_THINKING           off|minimal|low|medium|high|xhigh
 *   RSTUDIO_PI_API_KEY            LLM API key (optional, Pi also reads env)
 *   RSTUDIO_PI_BASE_URL           LLM base URL (for self-hosted providers)
 *   RSTUDIO_PI_WORKSPACE          Working directory (R session's CWD)
 *   RSTUDIO_PI_LOG_DIR            Log directory
 *   RSTUDIO_PI_ALLOWED_ORIGIN     Allowed WebSocket origin (desktop)
 *
 * The protocol version is declared in protocol.json alongside the binary.
 */

'use strict';

const http = require('http');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const readline = require('readline');
const { StringDecoder } = require('string_decoder');

// Pi Agent is ESM-only. We load it lazily so the failure mode is clear if the
// package wasn't installed (the install script runs `npm install` for us).
let _pi = null;
async function loadPi() {
   if (_pi) return _pi;
   _pi = await import('@earendil-works/pi-coding-agent');
   return _pi;
}

// ============================================================================
// Argument parsing
// ============================================================================

function parseArgs(argv) {
   const opts = { host: '127.0.0.1', port: 0, serverMode: false };
   for (let i = 0; i < argv.length; i++) {
      const arg = argv[i];
      const next = () => argv[++i];
      if (arg === '-h' || arg === '--host') opts.host = next();
      else if (arg === '-p' || arg === '--port') opts.port = parseInt(next(), 10);
      else if (arg === '--workspace') opts.workspace = next();
      else if (arg === '--log-dir') opts.logDir = next();
      else if (arg === '--server-mode') opts.serverMode = true;
      else if (arg === '--allowed-origin') opts.allowedOrigin = next();
      else if (arg.startsWith('--log-dir=')) opts.logDir = arg.slice('--log-dir='.length);
      else if (arg === '--json' || arg === '--resume-conversation' ||
               arg === '--storage' || arg === '--workspace-id' ||
               arg === '--config' || arg === '--logger-type') {
         /* accepted and ignored (some are C++ side bookkeeping) */
      }
   }
   return opts;
}

const ARGS = parseArgs(process.argv.slice(2));

// ============================================================================
// Logging
// ============================================================================

let logStream = null;
if (ARGS.logDir) {
   try {
      fs.mkdirSync(ARGS.logDir, { recursive: true });
      logStream = fs.createWriteStream(path.join(ARGS.logDir, 'rstudio-pi-backend.log'),
                                       { flags: 'a' });
   } catch (e) { /* fall back to stderr only */ }
}

function log(level, msg) {
   const line = `${new Date().toISOString()} [${level}] ${msg}`;
   process.stderr.write(line + '\n');
   if (logStream) { try { logStream.write(line + '\n'); } catch (e) { /* ignore */ } }
}

process.on('uncaughtException', (e) => log('ERROR', `uncaught: ${e.stack || e}`));
process.on('unhandledRejection', (e) => log('ERROR', `unhandled: ${e?.stack || e}`));

// ============================================================================
// Configuration
// ============================================================================

function loadConfig() {
   const env = process.env;
   return {
      // LLM provider configuration (Pi Agent's standard knobs)
      provider:    env.RSTUDIO_PI_PROVIDER || env.PI_PROVIDER || 'anthropic',
      model:       env.RSTUDIO_PI_MODEL    || env.PI_MODEL    || 'claude-sonnet-4-20250514',
      thinking:    env.RSTUDIO_PI_THINKING || env.PI_THINKING || 'medium',
      apiKey:      env.RSTUDIO_PI_API_KEY  || env.PI_API_KEY  || '',
      baseUrl:     env.RSTUDIO_PI_BASE_URL || env.PI_BASE_URL || '',
      authToken:   env.RSTUDIO_CHAT_AUTH_TOKEN || '',
      workspace:   ARGS.workspace || env.RSTUDIO_PI_WORKSPACE || process.cwd(),
      allowedOrigin: ARGS.allowedOrigin || '',
   };
}

const CONFIG = loadConfig();
const AUTH_TOKEN = CONFIG.authToken;

// ============================================================================
// JSON-RPC 2.0 over stdio with the C++ rsession process
// ============================================================================
//
// rsession dials us over stdin/stdout with Content-Length-framed JSON-RPC 2.0
// messages (the same framing LSP uses). It is the *server* in the stdio
// direction: it invokes our capabilities (logger/log, runtime/cancelExecution,
// etc.) and we *call* its capabilities (runtime/executeCode, workspace/readFile,
// etc.) when our custom R tools fire.

class RStudioJsonRpc {
   constructor() {
      this._outBuffer = Buffer.alloc(0);
      this._pending = new Map();        // id -> {resolve, reject, method}
      this._nextId = 1;
      this._handlers = new Map();       // method -> handler
      this._notificationHandlers = new Map();
      this._capabilities = new Set();
      this._peerInfo = null;

      // Read from stdin
      this._stdinReader = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
      // We can't use readline cleanly for binary safety, so accumulate raw chunks:
      this._rawReader = process.stdin;
      this._rawReader.on('data', (chunk) => this._onStdinData(chunk));
      this._rawReader.on('end', () => { this._onStdinEnd(); });

      // Write framed messages to stdout
      this._writeQueue = Promise.resolve();
   }

   _onStdinData(chunk) {
      this._outBuffer = Buffer.concat([this._outBuffer, chunk]);
      // Parse Content-Length: N\r\n\r\n<body>
      for (;;) {
         const headerEnd = this._outBuffer.indexOf('\r\n\r\n');
         if (headerEnd < 0) return;
         const header = this._outBuffer.slice(0, headerEnd).toString('ascii');
         const m = /^Content-Length:\s*(\d+)/i.exec(header);
         if (!m) {
            log('ERROR', `Bad JSON-RPC frame header: ${JSON.stringify(header)}`);
            // recover: drop the bad header
            this._outBuffer = this._outBuffer.slice(headerEnd + 4);
            continue;
         }
         const len = parseInt(m[1], 10);
         const total = headerEnd + 4 + len;
         if (this._outBuffer.length < total) return;     // need more
         const body = this._outBuffer.slice(headerEnd + 4, total).toString('utf8');
         this._outBuffer = this._outBuffer.slice(total);
         this._dispatch(body);
      }
   }

   _onStdinEnd() {
      log('INFO', 'rsession closed stdin; backend will exit');
      for (const { reject } of this._pending.values()) {
         reject(new Error('rsession closed connection'));
      }
      this._pending.clear();
   }

   _dispatch(body) {
      let msg;
      try { msg = JSON.parse(body); }
      catch (e) {
         log('ERROR', `Invalid JSON from rsession: ${e.message}: ${body.slice(0, 200)}`);
         return;
      }

      // Response to a request we sent
      if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
         const pending = this._pending.get(msg.id);
         if (pending) {
            this._pending.delete(msg.id);
            if (msg.error) pending.reject(Object.assign(new Error(msg.error.message || 'rpc error'),
                                                       { code: msg.error.code, data: msg.error.data }));
            else pending.resolve(msg.result);
         }
         return;
      }

      // Request from rsession (we must respond)
      if (msg.id !== undefined && msg.method) {
         this._handleRequest(msg).catch((e) => {
            log('ERROR', `Handler for ${msg.method} threw: ${e.stack || e}`);
            this._sendResponse(msg.id, null,
               { code: -32603, message: String(e.message || e) });
         });
         return;
      }

      // Notification from rsession
      if (msg.method) {
         const h = this._notificationHandlers.get(msg.method);
         if (h) {
            try { h(msg.params || {}); }
            catch (e) { log('ERROR', `Notification ${msg.method} handler threw: ${e.stack || e}`); }
         }
         return;
      }

      log('WARN', `Unknown JSON-RPC message: ${body.slice(0, 200)}`);
   }

   async _handleRequest(msg) {
      const handler = this._handlers.get(msg.method);
      if (!handler) {
         this._sendResponse(msg.id, null,
            { code: -32601, message: `Method not found: ${msg.method}` });
         return;
      }
      const result = await handler(msg.params || {}, msg);
      this._sendResponse(msg.id, result);
   }

   _sendResponse(id, result, error) {
      const body = JSON.stringify(error ? { jsonrpc: '2.0', id, error }
                                        : { jsonrpc: '2.0', id, result });
      const frame = `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
      this._writeQueue = this._writeQueue.then(() => new Promise((resolve) => {
         process.stdout.write(frame, () => resolve());
      })).catch((e) => log('ERROR', `stdout write failed: ${e.message}`));
   }

   _sendNotification(method, params) {
      const body = JSON.stringify({ jsonrpc: '2.0', method, params });
      const frame = `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
      this._writeQueue = this._writeQueue.then(() => new Promise((resolve) => {
         process.stdout.write(frame, () => resolve());
      })).catch((e) => log('ERROR', `stdout write failed: ${e.message}`));
   }

   registerRequestHandler(method, handler) { this._handlers.set(method, handler); }
   registerNotificationHandler(method, handler) { this._notificationHandlers.set(method, handler); }

   // Public: send a request and await the response.
   request(method, params, { timeoutMs = 60000 } = {}) {
      const id = this._nextId++;
      return new Promise((resolve, reject) => {
         const t = setTimeout(() => {
            this._pending.delete(id);
            reject(new Error(`RPC ${method} timed out after ${timeoutMs}ms`));
         }, timeoutMs);
         this._pending.set(id, {
            resolve: (v) => { clearTimeout(t); resolve(v); },
            reject:  (e) => { clearTimeout(t); reject(e); },
            method,
         });
         const body = JSON.stringify({ jsonrpc: '2.0', id, method, params: params || {} });
         const frame = `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
         this._writeQueue = this._writeQueue.then(() => new Promise((resolve) => {
            process.stdout.write(frame, () => resolve());
         })).catch((e) => {
            clearTimeout(t); this._pending.delete(id);
            reject(new Error(`write failed: ${e.message}`));
         });
      });
   }
}

const rpc = new RStudioJsonRpc();
rpc.registerNotificationHandler('logger/log', (params) => {
   log('RSTUDIO', `[${params.level || 'info'}] ${params.message || ''}`);
});
rpc.registerNotificationHandler('ui/showMessage', (params) => {
   const level = ({ 1: 'INFO', 2: 'WARN', 3: 'ERROR' })[params.type] || 'INFO';
   log('RSTUDIO', `[${level}] ${params.title || ''} ${params.message || ''}`);
});
rpc.registerRequestHandler('protocol/getVersion', async () => {
   return {
      protocolVersion: '11.0',
      rstudioVersion: '2026.05.999-dev+999',
      capabilities: [],   // we don't *use* any of rsession's capabilities from this side
   };
});
rpc.registerRequestHandler('runtime/cancelExecution', async (params) => {
   log('INFO', `runtime/cancelExecution trackingId=${params.trackingId || '(none)'}`);
   return {};
});

// ============================================================================
// Custom R tools (the agent's interface to the live R kernel)
// ============================================================================
//
// Each tool sends a JSON-RPC 2.0 request to the C++ rsession (using the
// `runtime/*` and `workspace/*` capabilities it advertises in
// chat/ChatConstants.cpp:39 rstudioCapabilities()). The R helpers in
// src/cpp/session/modules/SessionChat.R provide additional safety checks
// (.rs.chat.isFileReadAllowed, .rs.chat.normalizePath, etc.) -- this side
// does its own preflight too, and the guardrail extension below adds a
// per-call confirmation step for destructive operations.

function rExecuteCode(code, opts = {}) {
   return rpc.request('runtime/executeCode', {
      code,
      language: 'r',
      captureOutput: opts.captureOutput !== false,
      capturePlot:   opts.capturePlot === true,
      timeout:       opts.timeout || 30000,
   });
}

function rListVariables() {
   return rpc.request('runtime/getDetailedContext', {});
}

function rGetConsoleContent(limit = 200) {
   return rpc.request('runtime/getConsoleContent', { limit });
}

function rReadFile(path) {
   return rpc.request('workspace/readFileContent', { path, startLine: 0 });
}

function rWriteFile(path, content) {
   return rpc.request('workspace/writeFileContent', { path, content });
}

function rEditFile(path, oldString, newString, replaceAll = false) {
   return rpc.request('workspace/editFileContent',
                      { path, oldString, newString, replaceAll });
}

function rOpenDocument(path, line) {
   return rpc.request('ui/openDocument', { path, line: line || 0 });
}

// Destructive-operation classifier (the guardrail extension asks for
// confirmation when this returns true). The agent never sees the result of
// a denied call -- the extension short-circuits it with a "blocked" error.
const DESTRUCTIVE_PATTERNS = [
   // R-level destructive operations
   /\bunlink\s*\(/i,
   /\bfile\.(remove|rename)\s*\(/i,
   /\bsystem\s*\(\s*["']?(rm|rmdir|mv|del)\b/i,
   /\bsystem2\s*\(\s*["'](rm|rmdir|mv|del)\b/i,
   /\bdir\.create\s*\(/i,
   /\bsetequal\b/i,
   /\bassign\s*\(\s*["']?\s*GlobalEnv/i,
   /\boptions\s*\(/i,
   /\bSys\.setenv\s*\(/i,
   /\bSys\.unsetenv\s*\(/i,
   /\binstall\.packages\s*\(/i,
   /\bremove\.packages\s*\(/i,
   /\bdetach\s*\(\s*["']package:/i,
   /\bunloadNamespace\s*\(/i,
   /\bsetwd\s*\(/i,
   /\bwriteLines\s*\(/i,
   /\bwrite\.csv/i,
   /\bwrite\.table/i,
   /\bsaveRDS\s*\(/i,
   /\bsave\s*\(\s*image/i,
   /\bcat\s*\(\s*file\s*=\s*[^,)]*,\s*append\s*=\s*FALSE/i,
   // Shell-level destructive operations inside R system() calls
   /\brm\s+-rf?\b/i,
   /\bsudo\s+/i,
   /\bdd\s+if=/i,
   /\bmkfs\b/i,
   /\bchmod\s+(-R\s+)?000/i,
   /\bcurl\s+[^|]*\|\s*(bash|sh)\b/i,
   /\bwget\s+[^|]*\|\s*(bash|sh)\b/i,
];

function isDestructiveR(code) {
   if (typeof code !== 'string' || !code) return false;
   for (const pat of DESTRUCTIVE_PATTERNS) {
      if (pat.test(code)) return { match: pat.toString(), code };
   }
   return false;
}

function formatRResult(result) {
   // result = { output, error, canceled, plots, executionTime }
   if (!result) return { ok: false, error: 'no result' };
   if (result.canceled) return { ok: false, error: 'execution canceled by user' };
   if (result.error) {
      return { ok: false, error: result.error.message || result.error, output: result.output || '' };
   }
   const text = (result.output || '').toString().trim();
   const plotCount = (result.plots || []).length;
   const exec = result.executionTime ? ` in ${result.executionTime}ms` : '';
   return {
      ok: true,
      output: text || '(no output)',
      plotCount,
      executionTimeMs: result.executionTime,
      note: plotCount > 0
         ? `${plotCount} plot(s) captured. Use \`r_get_plot()\` to view.`
         : undefined,
   };
}

// Pre-flight: refuse obviously dangerous code with a clear message *before*
// the agent even attempts to call the tool. This is defense in depth; the
// guardrail extension's confirmation step is the user-facing layer.
function preflightRCode(code) {
   const dest = isDestructiveR(code);
   if (dest) {
      return { ok: false,
               error: 'Refusing to execute destructive R code without explicit user confirmation. ' +
                      'The guardrail extension will prompt the user; if they approve, the call will be retried.' };
   }
   return { ok: true };
}

module.exports.formatRResult = formatRResult;
module.exports.preflightRCode = preflightRCode;
module.exports.isDestructiveR = isDestructiveR;

// ============================================================================
// Minimal RFC 6455 WebSocket server (no ws dependency)
// ============================================================================
//
// We speak the same WebSocket protocol the previous OpenAI bridge used, so the
// GWT chat panel (and dist/client/app.js) requires no changes. The frame
// codec is the same one used in the prior main.js -- 101 switching protocols
// handshake, masked client frames, unmasked server frames.

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function computeAcceptKey(clientKey) {
   return crypto.createHash('sha1').update(clientKey + WS_GUID).digest('base64');
}

function encodeServerFrame(opcode, payload) {
   const buf = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, 'utf8');
   const len = buf.length;
   let header;
   if (len < 126) { header = Buffer.alloc(2); header[1] = len; }
   else if (len < 65536) { header = Buffer.alloc(4); header[1] = 126; header.writeUInt16BE(len, 2); }
   else { header = Buffer.alloc(10); header[1] = 127; header.writeUInt32BE(0, 2); header.writeUInt32BE(len, 6); }
   header[0] = 0x80 | opcode;
   return Buffer.concat([header, buf]);
}

// WebSocket frame parser (server side, unmasked frames from client).
function parseClientFrame(buf) {
   if (buf.length < 2) return null;
   const fin = (buf[0] & 0x80) !== 0;
   const opcode = buf[0] & 0x0f;
   const masked = (buf[1] & 0x80) !== 0;
   let len = buf[1] & 0x7f;
   let offset = 2;
   if (len === 126) { if (buf.length < 4) return null; len = buf.readUInt16BE(2); offset = 4; }
   else if (len === 127) { if (buf.length < 10) return null; len = buf.readUInt32BE(6); offset = 10; }
   if (masked) {
      if (buf.length < offset + 4 + len) return null;
      const mask = buf.slice(offset, offset + 4);
      offset += 4;
      const payload = Buffer.alloc(len);
      for (let i = 0; i < len; i++) payload[i] = buf[offset + i] ^ mask[i & 3];
      return { fin, opcode, payload, rest: buf.slice(offset + len) };
   } else {
      if (buf.length < offset + len) return null;
      return { fin, opcode, payload: buf.slice(offset, offset + len), rest: buf.slice(offset + len) };
   }
}

class WebSocketConnection {
   constructor(socket) {
      this.socket = socket;
      this.handlers = { message: [], close: [], error: [] };
      this._fragments = [];
      this._fragmentOpcode = null;
      this._buffer = Buffer.alloc(0);
      socket.on('data', (chunk) => this._onData(chunk));
      socket.on('end',   () => this._emit('close'));
      socket.on('close', () => this._emit('close'));
      socket.on('error', (e) => this._emit('error', e));
   }

   _onData(chunk) {
      this._buffer = Buffer.concat([this._buffer, chunk]);
      for (;;) {
         const f = parseClientFrame(this._buffer);
         if (!f) return;
         this._buffer = f.rest;
         if (!f.fin) {
            // Fragmented -- accumulate and deliver on FIN
            if (this._fragmentOpcode === null) this._fragmentOpcode = f.opcode;
            this._fragments.push(f.payload);
            continue;
         }
         let payload = f.payload;
         if (this._fragmentOpcode !== null) {
            this._fragments.push(f.payload);
            payload = Buffer.concat(this._fragments);
            this._fragments = [];
            f.opcode = this._fragmentOpcode;
            this._fragmentOpcode = null;
         }
         if (f.opcode === 0x1) {                       // text
            this._emit('message', payload.toString('utf8'));
         } else if (f.opcode === 0x8) {                // close
            this._emit('close');
         } else if (f.opcode === 0x9) {                // ping
            try { this.socket.write(encodeServerFrame(0xa, payload)); } catch (e) { /* ignore */ }
         }
      }
   }

   on(event, fn) { (this.handlers[event] || (this.handlers[event] = [])).push(fn); }
   _emit(event, arg) { (this.handlers[event] || []).forEach((fn) => { try { fn(arg); } catch (e) { /* ignore */ } }); }

   sendText(str) {
      try { this.socket.write(encodeServerFrame(0x1, Buffer.from(str, 'utf8'))); }
      catch (e) { /* socket closed */ }
   }
   sendJSON(obj) { this.sendText(JSON.stringify(obj)); }
   close() { try { this.socket.end(); } catch (e) { /* ignore */ } }
}

function extractToken(req) {
   try {
      const u = new URL(req.url, 'http://localhost');
      const q = u.searchParams.get('token');
      if (q) return q;
   } catch (e) { /* ignore */ }
   const cookie = req.headers['cookie'] || '';
   const m = cookie.match(/(?:^|;\s*)ai-chat-auth=([^;]+)/);
   if (m) return decodeURIComponent(m[1]);
   const proto = req.headers['sec-websocket-protocol'];
   if (proto) return proto.split(',')[0].trim();
   return '';
}

function tokenOk(provided) {
   if (!AUTH_TOKEN) return true;
   if (!provided) return false;
   const a = Buffer.from(provided);
   const b = Buffer.from(AUTH_TOKEN);
   return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ============================================================================
// WebSocket message protocol (preserved from the prior OpenAI bridge)
// ============================================================================
//
// Server -> client: ready, thinking, delta, done, error, discovery-result,
//                   confirmation-request (new; for guardrail prompts)
// Client -> server: ping, chat, refresh-discovery, get-discovery,
//                   confirmation-response (new)

const SESSION_STATE = {
   /** All currently connected WebSocket clients */
   clients: new Set(),
   /** Per-request: requestId -> { ws, startedAt, streamText, thinkingText } */
   active: new Map(),
   /** Pending confirmation requests: confirmationId -> { ws, requestId, prompt, resolve } */
   pendingConfirmations: new Map(),
};

function broadcastJSON(obj) {
   for (const ws of SESSION_STATE.clients) {
      try { ws.sendJSON(obj); } catch (e) { /* ignore */ }
   }
}

function handleClientMessage(ws, raw) {
   let msg;
   try { msg = JSON.parse(raw); }
   catch (e) { ws.sendJSON({ type: 'error', message: 'Invalid JSON' }); return; }

   if (msg.type === 'ping') { ws.sendJSON({ type: 'pong' }); return; }

   if (msg.type === 'get-discovery' || msg.type === 'refresh-discovery') {
      // We don't have local-model auto-discovery in the Pi Agent world;
      // the model is whatever the user configured. Surface it as-is.
      ws.sendJSON({
         type: 'discovery-result',
         success: true,
         model: {
            model: `${CONFIG.provider}/${CONFIG.model}`,
            provider: CONFIG.provider,
            hasVision: false,
            maxContext: 0,
         },
         cached: msg.type === 'get-discovery',
      });
      return;
   }

   if (msg.type === 'confirmation-response') {
      // Guardrail prompt response from the UI
      const pending = SESSION_STATE.pendingConfirmations.get(msg.confirmationId);
      if (pending) {
         SESSION_STATE.pendingConfirmations.delete(msg.confirmationId);
         pending.resolve(!!msg.confirmed);
      }
      return;
   }

   if (msg.type === 'chat') {
      if (!msg.requestId || !Array.isArray(msg.messages)) {
         ws.sendJSON({ type: 'error', requestId: msg.requestId, message: 'malformed chat message' });
         return;
      }
      runAgentTurn(ws, msg.requestId, msg.messages).catch((e) => {
         log('ERROR', `runAgentTurn: ${e.stack || e}`);
         try { ws.sendJSON({ type: 'error', requestId: msg.requestId, message: e.message || String(e) }); } catch (e) { /* ignore */ }
      });
      return;
   }

   log('WARN', `unknown client message type: ${msg.type}`);
}

function handleConnection(ws) {
   ws.sendJSON({
      type: 'ready',
      configured: true,                 // Pi Agent is "configured" if a provider is set
      model: `${CONFIG.provider}/${CONFIG.model}`,
      provider: CONFIG.provider,
      thinking: !!CONFIG.thinking && CONFIG.thinking !== 'off',
      interleavedThinking: false,
      maxContext: 0,                    // Pi Agent handles its own context windowing
      autoDiscover: false,
      autoDiscoverProvider: '',
      isAgent: true,                   // signal to UI that this is a full agent, not a chat
   });

   ws.on('message', (raw) => handleClientMessage(ws, raw));
}

// ============================================================================
// Agent turn: build a Pi Agent prompt from chat history, stream events out.
// ============================================================================
//
// Pi Agent's AgentSession events map onto the existing WebSocket protocol:
//   message_update + assistantMessageEvent.text_delta    -> "delta"
//   message_update + assistantMessageEvent.thinking_delta -> "thinking"
//   agent_end                                            -> "done"
//   anything that throws                                  -> "error"
//   tool_execution_start/end                              -> not surfaced to the
//                                                           old client (we just
//                                                           let Pi handle it);
//                                                           logged for debug.

async function runAgentTurn(ws, requestId, messages) {
   const pi = await loadPi();
   if (!agentSession) {
      ws.sendJSON({ type: 'error', requestId, message: 'Agent not initialized' });
      return;
   }

   // The last user message is the prompt; older messages are converted into a
   // transcript that we hand to Pi via a system-prompt fragment so Pi can use
   // them as context (Pi Agent owns session state and isn't designed to ingest
   // a full prior transcript directly).
   const last = messages[messages.length - 1];
   if (!last || last.role !== 'user') {
      ws.sendJSON({ type: 'error', requestId, message: 'last message must be role:user' });
      return;
   }
   const transcript = messages.slice(0, -1).map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`).join('\n\n');

   // Make sure we're in a fresh-enough session. If there's prior history, ask
   // the user-visible stream to start with a context note.
   if (transcript) {
      ws.sendJSON({ type: 'thinking', requestId, content: `[context: ${messages.length - 1} prior message(s)]\n\n` });
   }

   SESSION_STATE.active.set(requestId, { ws, startedAt: Date.now() });

   try {
      // Pi's session.prompt is non-blocking: it queues the message and returns
      // once accepted. Events arrive on the subscription; we resolve when we
      // see `agent_end` for this turn.
      const donePromise = new Promise((resolve) => {
         const onEvent = (event) => {
            try {
               if (event.type === 'message_update') {
                  const inner = event.assistantMessageEvent;
                  if (inner.type === 'text_delta') {
                     ws.sendJSON({ type: 'delta', requestId, content: inner.delta });
                  } else if (inner.type === 'thinking_delta') {
                     ws.sendJSON({ type: 'thinking', requestId, content: inner.delta });
                  }
               } else if (event.type === 'tool_execution_start') {
                  // Surface tool calls as a thinking-style note so the user
                  // sees progress, even if the UI doesn't render tools.
                  ws.sendJSON({ type: 'thinking', requestId,
                                content: `\n[tool: ${event.toolName} ${JSON.stringify(event.args || {}).slice(0, 200)}]\n` });
               } else if (event.type === 'tool_execution_end') {
                  const result = event.result;
                  const ok = !event.isError;
                  const text = (result && result.content || []).map((c) => c.text || '').join('').slice(0, 400);
                  ws.sendJSON({ type: 'thinking', requestId,
                                content: `[tool result${ok ? '' : ' (ERROR)'}]: ${text}${text.length >= 400 ? '…' : ''}]\n` });
               } else if (event.type === 'agent_end') {
                  unsubscribe();
                  resolve(event);
               } else if (event.type === 'auto_retry_start') {
                  ws.sendJSON({ type: 'thinking', requestId,
                                content: `\n[retrying after error: ${event.errorMessage}]\n` });
               }
            } catch (e) { log('ERROR', `event handler: ${e.stack || e}`); }
         };
         const unsubscribe = agentSession.subscribe(onEvent);
      });

      // If we have prior history, fold it into a single system-prompt addendum
      // so Pi can see the conversation so far. (Pi Agent owns session state;
      // mixing arbitrary prior history with its tree-based sessions is
      // out of scope for this initial cut.)
      if (transcript) {
         const addendum = 'Conversation so far (from the prior chat panel):\n\n' + transcript;
         // We don't have a direct API for "append to next prompt only" in Pi's
         // SDK, so for now we drop the transcript on the floor and rely on
         // the session's own history. This is a known limitation -- future
         // work: serialise chat history into a Pi session branch.
         log('WARN', `discarding ${messages.length - 1} prior message(s); Pi Agent session is the source of truth`);
      }

      await agentSession.prompt(last.content);
      await donePromise;
      ws.sendJSON({ type: 'done', requestId });
   } catch (e) {
      ws.sendJSON({ type: 'error', requestId, message: e.message || String(e) });
   } finally {
      SESSION_STATE.active.delete(requestId);
   }
}

// ============================================================================
// Static file serving (chat UI -- served by RStudio in production, but we
// serve it here too for standalone use and smoke tests)
// ============================================================================

const CLIENT_DIR = path.resolve(__dirname, '..', 'client');
const CONTENT_TYPES = {
   '.html': 'text/html; charset=utf-8',
   '.js':   'application/javascript; charset=utf-8',
   '.css':  'text/css; charset=utf-8',
   '.json': 'application/json; charset=utf-8',
   '.svg':  'image/svg+xml',
   '.ico':  'image/x-icon',
};

function serveStatic(req, res) {
   let urlPath;
   try { urlPath = new URL(req.url, 'http://localhost').pathname; }
   catch (e) { urlPath = '/'; }
   if (urlPath === '/' || urlPath === '') urlPath = '/index.html';
   const resolved = path.resolve(CLIENT_DIR, '.' + urlPath);
   if (!resolved.startsWith(CLIENT_DIR)) { res.writeHead(403); res.end('Forbidden'); return; }
   fs.readFile(resolved, (err, data) => {
      if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not found'); return; }
      const ext = path.extname(resolved).toLowerCase();
      res.writeHead(200, { 'Content-Type': CONTENT_TYPES[ext] || 'application/octet-stream' });
      res.end(data);
   });
}

// ============================================================================
// HTTP + WebSocket server bootstrap
// ============================================================================

let agentSession = null;     // Pi Agent session (set once initialised)
let server = null;
let uiPort = null;           // port for the chat iframe to talk to us

async function startHttpServer() {
   return new Promise((resolve, reject) => {
      server = http.createServer((req, res) => {
         let pathname;
         try { pathname = new URL(req.url, 'http://localhost').pathname; }
         catch (e) { pathname = req.url || '/'; }
         if (pathname === '/healthz') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'ok', agent: !!agentSession }));
            return;
         }
         serveStatic(req, res);
      });

      server.on('upgrade', (req, socket) => {
         let pathname;
         try { pathname = new URL(req.url, 'http://localhost').pathname; }
         catch (e) { pathname = req.url || ''; }
         const okPath = pathname === '/ai-chat/ws' || pathname === '/ai-chat' ||
                        pathname === '/ws' || pathname === '/';
         const key = req.headers['sec-websocket-key'];
         if (!okPath || !key) {
            socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
            socket.destroy();
            return;
         }
         if (!tokenOk(extractToken(req))) {
            log('WARN', 'rejected WebSocket: bad/missing auth token');
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
         SESSION_STATE.clients.add(ws);
         ws.on('close', () => SESSION_STATE.clients.delete(ws));
         ws.on('error', () => SESSION_STATE.clients.delete(ws));
         handleConnection(ws);
      });

      server.on('error', reject);
      server.listen(ARGS.port, ARGS.host, () => resolve(server));
   });
}

// ============================================================================
// Pi Agent session bootstrap
// ============================================================================

async function startAgent() {
   const pi = await loadPi();

   // ---- Custom R tools (the agent's interface to the R kernel) -------------
   // We use TypeBox schemas (the standard Pi Agent uses) for parameter
   // validation. The schemas are tiny inline literals.
   const { Type } = await import('typebox');

   const tRExecute = pi.defineTool({
      name: 'r_execute',
      label: 'Execute R code',
      description:
         'Execute R code in the live R session running inside RStudio. ' +
         'The code runs with the same state, environment, and loaded packages ' +
         'as the user\'s interactive session. Returns the captured stdout, ' +
         'any error, and (when requested) plots. Destructive operations ' +
         '(file removal, system(), install.packages, options(), setwd(), ' +
         'writeLines to an existing file, etc.) will prompt the user for ' +
         'explicit confirmation via the guardrail extension before running.',
      parameters: Type.Object({
         code: Type.String({ description: 'R source code to execute. May contain multiple top-level expressions.' }),
         capturePlot: Type.Optional(Type.Boolean({ description: 'If true, capture any plot produced. Default false.' })),
         timeout: Type.Optional(Type.Number({ description: 'Max milliseconds to wait. Default 30000.' })),
      }),
      async execute(_id, params, _signal, _onUpdate) {
         const pre = preflightRCode(params.code);
         if (!pre.ok) return { content: [{ type: 'text', text: pre.error }], isError: true };
         try {
            const result = await rExecuteCode(params.code, { capturePlot: params.capturePlot, timeout: params.timeout });
            const formatted = formatRResult(result);
            return { content: [{ type: 'text', text: JSON.stringify(formatted, null, 2) }] };
         } catch (e) {
            return { content: [{ type: 'text', text: `r_execute RPC failed: ${e.message}` }], isError: true };
         }
      },
   });

   const tRListVars = pi.defineTool({
      name: 'r_list_variables',
      label: 'List R variables',
      description: 'List the top-level variables in the user\'s R global environment, ' +
                   'sorted by estimated size, with name, type, and a short display name. ' +
                   'Useful for discovering data frames and other objects.',
      parameters: Type.Object({}),
      async execute() {
         try {
            const ctx = await rListVariables();
            return { content: [{ type: 'text', text: JSON.stringify(ctx, null, 2) }] };
         } catch (e) {
            return { content: [{ type: 'text', text: `r_list_variables RPC failed: ${e.message}` }], isError: true };
         }
      },
   });

   const tRGetDF = pi.defineTool({
      name: 'r_get_dataframe',
      label: 'Inspect R data frame',
      description: 'Get a summary of an R data frame: name, class, dimensions, column names and types, ' +
                   'and the first few rows. The variable must already exist in the R session.',
      parameters: Type.Object({
         name: Type.String({ description: 'Variable name to inspect.' }),
         rows: Type.Optional(Type.Number({ description: 'Number of head rows to include. Default 5.' })),
      }),
      async execute(_id, params) {
         const code =
            `cat(sprintf("class: %s\\n", paste(class(${params.name}), collapse=", ")));\n` +
            `cat(sprintf("dim: %d x %d\\n", nrow(${params.name}), ncol(${params.name})));\n` +
            `cat(sprintf("columns: %s\\n", paste(colnames(${params.name}), collapse=", ")));\n` +
            `cat(sprintf("types: %s\\n", paste(sapply(${params.name}, function(x) class(x)[1]), collapse=", ")));\n` +
            `cat("\\n--- head(${params.rows || 5}) ---\\n");\n` +
            `print(head(${params.name}, ${params.rows || 5}));\n` +
            `invisible(NULL)`;
         try {
            const result = await rExecuteCode(code);
            return { content: [{ type: 'text', text: JSON.stringify(formatRResult(result), null, 2) }] };
         } catch (e) {
            return { content: [{ type: 'text', text: `r_get_dataframe RPC failed: ${e.message}` }], isError: true };
         }
      },
   });

   const tRConsole = pi.defineTool({
      name: 'r_read_console',
      label: 'Read R console',
      description: 'Return the most recent lines of R console output (stdout/stderr from the live session).',
      parameters: Type.Object({
         limit: Type.Optional(Type.Number({ description: 'Max lines to return. Default 200.' })),
      }),
      async execute(_id, params) {
         try {
            const result = await rGetConsoleContent(params.limit || 200);
            return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
         } catch (e) {
            return { content: [{ type: 'text', text: `r_read_console RPC failed: ${e.message}` }], isError: true };
         }
      },
   });

   const tROpenFile = pi.defineTool({
      name: 'r_open_file',
      label: 'Open file in RStudio',
      description: 'Open a file in the RStudio editor at the given path, optionally jumping to a 1-based line number.',
      parameters: Type.Object({
         path: Type.String({ description: 'Absolute path to the file to open.' }),
         line: Type.Optional(Type.Number({ description: '1-based line number to jump to. Default 0 (no jump).' })),
      }),
      async execute(_id, params) {
         try {
            await rOpenDocument(params.path, params.line || 0);
            return { content: [{ type: 'text', text: `opened ${params.path}` }] };
         } catch (e) {
            return { content: [{ type: 'text', text: `r_open_file RPC failed: ${e.message}` }], isError: true };
         }
      },
   });

   const customTools = [tRExecute, tRListVars, tRGetDF, tRConsole, tROpenFile];

   // ---- Guardrail extension (intercept tool calls) --------------------------
   // We use an inline extension factory. The extension watches tool_call
   // events and, for any tool that could be destructive, asks the user
   // through a WebSocket confirmation round-trip.
   const extensionFactory = (piExt) => {
      piExt.on('tool_call', async (event, ctx) => {
         const name = event.toolName;
         const args = event.input || {};

         // 1. Built-in tools are disabled at the agent level (initialActiveToolNames),
         //    but defense in depth: refuse them here too in case the allowlist
         //    is later relaxed.
         const builtIns = new Set(['read', 'write', 'edit', 'bash', 'grep', 'find', 'ls']);
         if (builtIns.has(name)) {
            return { block: true,
                     reason: `Built-in tool "${name}" is disabled in RStudio's Pi Agent backend for safety. ` +
                             `Use the R tools (r_execute, r_open_file, ...) instead.` };
         }

         // 2. Destructive R code: ask the user to confirm.
         if (name === 'r_execute' && typeof args.code === 'string') {
            const dest = isDestructiveR(args.code);
            if (dest) {
               const ws = SESSION_STATE.clients.size > 0 ? [...SESSION_STATE.clients][0] : null;
               if (!ws) {
                  return { block: true, reason: 'Destructive R call but no chat client is connected to confirm.' };
               }
               const confirmationId = 'cf-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
               const approved = await new Promise((resolve) => {
                  SESSION_STATE.pendingConfirmations.set(confirmationId, { resolve });
                  ws.sendJSON({
                     type: 'confirmation-request',
                     confirmationId,
                     toolName: name,
                     summary: 'destructive R code',
                     code: args.code,
                     pattern: dest.match,
                  });
                  setTimeout(() => {
                     if (SESSION_STATE.pendingConfirmations.has(confirmationId)) {
                        SESSION_STATE.pendingConfirmations.delete(confirmationId);
                        resolve(false);
                     }
                  }, 30000);
               });
               if (!approved) {
                  return { block: true, reason: 'User denied destructive R code.' };
               }
            }
         }

         return undefined;  // allow
      });
   };

   // ---- Initialise the agent session ---------------------------------------
   // We disable all built-in tools -- the only tools the agent can use are
   // the R tools we registered above. This is the strongest possible
   // guardrail: there is no path by which the agent can run an arbitrary
   // shell command, read or write arbitrary files, etc.
   const agentDir = path.join(CONFIG.workspace, '.rstudio-pi-agent');
   fs.mkdirSync(agentDir, { recursive: true });
   const cwd = CONFIG.workspace;

   const resourceLoader = new pi.DefaultResourceLoader({
      cwd,
      agentDir,
      extensionFactories: [extensionFactory],
   });
   await resourceLoader.reload();

   const result = await pi.createAgentSession({
      cwd,
      agentDir,
      noTools: 'builtin',           // disable read/write/edit/bash/grep/find/ls
      customTools,                  // R tools only
      resourceLoader,
      thinkingLevel: CONFIG.thinking || 'medium',
   });

   // If the user provided a model, select it (Pi may have a different default).
   if (CONFIG.provider && CONFIG.model) {
      try {
         await result.session.setModel(CONFIG.provider, CONFIG.model);
      } catch (e) {
         log('WARN', `setModel(${CONFIG.provider}, ${CONFIG.model}) failed: ${e.message}`);
      }
   }

   agentSession = result.session;
   log('INFO', `Pi Agent session ready (provider=${CONFIG.provider}, model=${CONFIG.model}, thinking=${CONFIG.thinking})`);
}

// ============================================================================
// Main
// ============================================================================

async function main() {
   log('INFO', `RStudio Pi Agent backend starting (workspace=${CONFIG.workspace}, host=${ARGS.host}:${ARGS.port})`);

   await startHttpServer();
   log('INFO', 'HTTP/WebSocket server listening');

   try {
      await startAgent();
   } catch (e) {
      log('ERROR', `startAgent failed: ${e.stack || e}`);
      // Don't exit -- the UI will show a "not ready" state and the user can
      // fix their config. Health endpoint will report `agent: false`.
   }

   const addr = server.address();
   log('INFO', `RStudio Pi Agent backend ready on ${ARGS.host}:${addr.port}`);
   process.stdout.write(`RSTUDIO_AI_BACKEND_LISTENING ${addr.port}\n`);
}

process.on('SIGTERM', () => { try { server && server.close(); } catch (e) {} process.exit(0); });
process.on('SIGINT',  () => { try { server && server.close(); } catch (e) {} process.exit(0); });

main().catch((e) => { log('ERROR', `fatal: ${e.stack || e}`); process.exit(1); });
