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

function buildMessages(history, cfg)
{
   const system = { role: 'system', content: SYSTEM_PROMPT };

   // Reserve part of the window for the model's reply.
   const reserve = Math.min(Math.floor(cfg.maxContext / 4), 4096);
   let budget = Math.max(cfg.maxContext - reserve - estimateTokens(SYSTEM_PROMPT), 512);

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

function buildRequestBody(history, cfg)
{
   const body = {
      model: cfg.model,
      messages: buildMessages(history, cfg),
      stream: true
   };
   if (cfg.thinking)
   {
      // Standard OpenAI reasoning control; supported by o-series and many
      // OpenAI-compatible servers. Harmless hint for others.
      body.reasoning_effort = 'medium';
   }
   return body;
}

// Stream a completion to the given WebSocket connection.
async function streamCompletion(ws, requestId, history, cfg)
{
   const url = cfg.baseUrl + '/chat/completions';
   const headers = { 'Content-Type': 'application/json' };
   if (cfg.apiKey) headers['Authorization'] = 'Bearer ' + cfg.apiKey;

   const controller = new AbortController();
   const onClose = () => controller.abort();
   ws.on('close', onClose);

   let reader = null;
   try
   {
      let resp;
      try
      {
         resp = await fetch(url, {
            method: 'POST',
            headers,
            body: JSON.stringify(buildRequestBody(history, cfg)),
            signal: controller.signal
         });
      }
      catch (e)
      {
         ws.sendJSON({ type: 'error', requestId, message: `Request to ${url} failed: ${e.message}` });
         return;
      }

      if (!resp.ok)
      {
         let detail = '';
         try { detail = await resp.text(); } catch (e) { /* ignore */ }
         ws.sendJSON({ type: 'error', requestId, message: `Provider returned ${resp.status} ${resp.statusText}: ${detail.slice(0, 1000)}` });
         return;
      }

      reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let sseBuffer = '';

      const dispatchData = (data) =>
      {
         if (data === '[DONE]') return false;
         let json;
         try { json = JSON.parse(data); } catch (e) { return true; }
         const choice = json.choices && json.choices[0];
         if (!choice) return true;
         const delta = choice.delta || {};
         // Reasoning content is exposed under different keys by different providers.
         const reasoning = delta.reasoning_content || delta.reasoning;
         if (reasoning && cfg.thinking)
            ws.sendJSON({ type: 'thinking', requestId, content: reasoning });
         if (typeof delta.content === 'string' && delta.content.length)
            ws.sendJSON({ type: 'delta', requestId, content: delta.content });
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
               if (!dispatchData(data)) { ws.sendJSON({ type: 'done', requestId }); return; }
            }
         }
      }

      ws.sendJSON({ type: 'done', requestId });
   }
   catch (e)
   {
      if (!controller.signal.aborted)
         ws.sendJSON({ type: 'error', requestId, message: `Stream error: ${e.message}` });
   }
   finally
   {
      // Always detach the per-request close handler (otherwise handlers
      // accumulate one closure per turn on a long-lived socket), and release
      // the upstream response body so no socket is left dangling after [DONE].
      ws.off('close', onClose);
      if (reader)
      {
         try { await reader.cancel(); } catch (e) { /* ignore */ }
      }
   }
}

// ---------------------------------------------------------------------------
// WebSocket message protocol
// ---------------------------------------------------------------------------

function handleConnection(ws)
{
   const cfg = loadConfig(); // re-read per connection so pref changes take effect

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
         if (!code) { ws.sendJSON({ type: 'insertResult', success: false, message: 'No code provided', action: 'cursor' }); return; }
         // In standalone mode (no RStudio), send a graceful not-supported response.
         // When running under RStudio, this handler would call the RStudio C++ backend
         // via the JSON-RPC stdin/stdout channel to perform the actual insertion.
         ws.sendJSON({ type: 'insertResult', success: false, message: 'Not available in standalone mode', action: 'cursor' });
         return;
      }

      // Insert generated code into a new untitled document.
      if (msg.type === 'insertIntoNewFile')
      {
         const code = typeof msg.code === 'string' ? msg.code : '';
         if (!code) { ws.sendJSON({ type: 'insertResult', success: false, message: 'No code provided', action: 'newfile' }); return; }
         // In standalone mode (no RStudio), send a graceful not-supported response.
         // When running under RStudio, this handler would call the RStudio C++ backend
         // via the JSON-RPC stdin/stdout channel to create the new file.
         ws.sendJSON({ type: 'insertResult', success: false, message: 'Not available in standalone mode', action: 'newfile' });
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
   // Emit a machine-readable line so callers/tests can discover the port.
   process.stdout.write(`RSTUDIO_AI_BACKEND_LISTENING ${addr.port}\n`);
});

process.on('SIGTERM', () => { try { server.close(); } catch (e) {} process.exit(0); });
process.on('SIGINT', () => { try { server.close(); } catch (e) {} process.exit(0); });
