/*
 * smoke.js
 *
 * End-to-end smoke test for the RStudio Pi Agent backend. It:
 *
 *   1. stands up a *mock C++ rsession* that speaks JSON-RPC 2.0 over stdio
 *      (the protocol the real rsession uses) and answers the requests the
 *      backend makes -- protocol/getVersion, runtime/executeCode,
 *      runtime/getDetailedContext, etc.;
 *
 *   2. spawns dist/server/main.js with its stdin/stdout piped to the mock
 *      rsession (so the backend's JSON-RPC client thinks it's talking to the
 *      real C++ rsession);
 *
 *   3. connects a built-in WebSocket client and asserts: auth enforcement,
 *      the ready handshake, the discovery round-trip, and (optionally) a
 *      chat round-trip -- the latter will fail without a real LLM key, so
 *      we skip it by default and only run it when SMOKE_TEST_CHAT=1.
 *
 * Run: node test/smoke.js   (from the ai-backend directory)
 *
 * No external dependencies. The legacy OpenAI-bridge mock at
 * test/mock-openai.js is kept for backward compatibility but is no longer
 * used by this smoke test.
 */
'use strict';

const net = require('net');
const http = require('http');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAIN = path.resolve(__dirname, '..', 'dist', 'server', 'main.js');
const AUTH = 'test-token-pi-bridge';

let failures = 0;
function check(name, cond) {
   console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name);
   if (!cond) failures++;
}

// ---------------------------------------------------------------------------
// Mock C++ rsession: speaks JSON-RPC 2.0 over the supplied stdio streams.
// ---------------------------------------------------------------------------
//
// The real C++ rsession dials *us* (the backend) over stdio with
// Content-Length-framed JSON-RPC 2.0 messages. We reply with the same
// framing. For the smoke test we only need to handle the requests the
// backend actually sends:
//   - protocol/getVersion             (we ignore; the backend's
//                                       protocol/getVersion handler runs on
//                                       *our* side and never gets called in
//                                       the smoke test -- rsession's greeting
//                                       arrives first)
//   - runtime/executeCode             (returns canned R output)
//   - runtime/getDetailedContext      (returns a single fake data frame)
//   - runtime/getConsoleContent       (returns empty)
//
// The real C++ rsession also sends notifications and capability requests at
// startup; we accept and discard them.

function frameMessage(obj) {
   const body = JSON.stringify(obj);
   return `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
}

function parseFrame(buffer) {
   // Returns { body, rest } or null if not enough data yet.
   const headerEnd = buffer.indexOf('\r\n\r\n');
   if (headerEnd < 0) return null;
   const header = buffer.slice(0, headerEnd).toString('ascii');
   const m = /^Content-Length:\s*(\d+)/i.exec(header);
   if (!m) {
      // malformed; recover by skipping 4 bytes
      return { body: null, rest: buffer.slice(headerEnd + 4) };
   }
   const len = parseInt(m[1], 10);
   const total = headerEnd + 4 + len;
   if (buffer.length < total) return null;
   return { body: buffer.slice(headerEnd + 4, total).toString('utf8'),
            rest: buffer.slice(total) };
}

class MockRSession {
   constructor() {
      this._buffer = Buffer.alloc(0);
      this._writeBuf = [];
      this._onMessage = () => {};
   }

   feed(chunk) {
      this._buffer = Buffer.concat([this._buffer, chunk]);
      for (;;) {
         const f = parseFrame(this._buffer);
         if (!f) break;
         this._buffer = f.rest;
         if (f.body) {
            try {
               const msg = JSON.parse(f.body);
               this._handleMessage(msg);
            } catch (e) { /* ignore */ }
         }
      }
   }

   _handleMessage(msg) {
      // Notifications have no id -- discard.
      if (msg.id === undefined) return;
      // Requests from the backend -> respond with a canned answer.
      let result;
      switch (msg.method) {
         case 'runtime/executeCode':
            // Echo the code as if R evaluated it.
            result = { output: `R> ${(msg.params.code || '').trim()}\n[1] 42\n`,
                       error: null, canceled: false, plots: [], executionTime: 1 };
            break;
         case 'runtime/getDetailedContext':
            result = { variables: [
               { name: 'x', type: 'numeric', displayName: 'x' },
               { name: 'mtcars', type: 'data.frame', displayName: 'mtcars [32 x 11]' }
            ], openFiles: [], platformInfo: {} };
            break;
         case 'runtime/getConsoleContent':
            result = { content: '' };
            break;
         case 'runtime/getActiveSession':
            result = { language: 'R', version: '4.6.0', sessionId: 'smoke', mode: 'console' };
            break;
         default:
            // unknown method -> JSON-RPC method-not-found
            this._send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'not implemented in mock' } });
            return;
      }
      this._send({ jsonrpc: '2.0', id: msg.id, result });
   }

   _send(obj) {
      this._onMessage(frameMessage(obj));
   }
}

// ---------------------------------------------------------------------------
// Minimal WebSocket client (masked frames)
// ---------------------------------------------------------------------------

function wsConnect(port, token) {
   return new Promise((resolve, reject) => {
      const key = crypto.randomBytes(16).toString('base64');
      const socket = net.connect(port, '127.0.0.1', () => {
         const pathUrl = '/ai-chat/ws' + (token !== null ? ('?token=' + encodeURIComponent(token)) : '');
         socket.write(
            'GET ' + pathUrl + ' HTTP/1.1\r\n' +
            'Host: 127.0.0.1:' + port + '\r\n' +
            'Upgrade: websocket\r\n' +
            'Connection: Upgrade\r\n' +
            'Sec-WebSocket-Key: ' + key + '\r\n' +
            'Sec-WebSocket-Version: 13\r\n\r\n');
      });

      let handshakeDone = false;
      let buf = Buffer.alloc(0);
      const messageHandlers = [];
      const api = {
         onMessage: (fn) => messageHandlers.push(fn),
         sendJSON: (obj) => socket.write(encodeClientFrame(0x1, Buffer.from(JSON.stringify(obj)))),
         close: () => socket.destroy(),
      };

      socket.on('data', (chunk) => {
         buf = Buffer.concat([buf, chunk]);
         if (!handshakeDone) {
            const idx = buf.indexOf('\r\n\r\n');
            if (idx === -1) return;
            const head = buf.slice(0, idx).toString('utf8');
            buf = buf.slice(idx + 4);
            const statusLine = head.split('\r\n')[0];
            if (!/101/.test(statusLine)) {
               reject(new Error('handshake failed: ' + statusLine));
               socket.destroy();
               return;
            }
            const accept = /sec-websocket-accept:\s*(.+)/i.exec(head);
            const expected = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
            if (!accept || accept[1].trim() !== expected) {
               reject(new Error('bad accept key'));
               socket.destroy();
               return;
            }
            handshakeDone = true;
            resolve(api);
         }
         for (;;) {
            const frame = parseServerFrame(buf);
            if (!frame) break;
            buf = frame.rest;
            if (frame.opcode === 0x1) {
               const str = frame.payload.toString('utf8');
               messageHandlers.forEach((fn) => fn(str));
            }
         }
      });

      socket.on('error', (e) => { if (!handshakeDone) reject(e); });
   });
}

function encodeClientFrame(opcode, payload) {
   const len = payload.length;
   let header;
   if (len < 126) { header = Buffer.alloc(2); header[1] = 0x80 | len; }
   else if (len < 65536) { header = Buffer.alloc(4); header[1] = 0x80 | 126; header.writeUInt16BE(len, 2); }
   else { header = Buffer.alloc(10); header[1] = 0x80 | 127; header.writeUInt32BE(0, 2); header.writeUInt32BE(len, 6); }
   header[0] = 0x80 | opcode;
   const mask = crypto.randomBytes(4);
   const masked = Buffer.alloc(len);
   for (let i = 0; i < len; i++) masked[i] = payload[i] ^ mask[i & 3];
   return Buffer.concat([header, mask, masked]);
}

function parseServerFrame(buf) {
   if (buf.length < 2) return null;
   const opcode = buf[0] & 0x0f;
   let len = buf[1] & 0x7f;
   let offset = 2;
   if (len === 126) { if (buf.length < 4) return null; len = buf.readUInt16BE(2); offset = 4; }
   else if (len === 127) { if (buf.length < 10) return null; len = buf.readUInt32BE(6); offset = 10; }
   if (buf.length < offset + len) return null;
   return { opcode, payload: buf.slice(offset, offset + len), rest: buf.slice(offset + len) };
}

function collect(api, { until, timeout }) {
   return new Promise((resolve) => {
      const msgs = [];
      const t = setTimeout(() => resolve(msgs), timeout || 4000);
      api.onMessage((str) => {
         let m; try { m = JSON.parse(str); } catch (e) { return; }
         msgs.push(m);
         if (until && until(m)) { clearTimeout(t); resolve(msgs); }
      });
   });
}

function expectUnauthorized(port, token) {
   return new Promise((resolve) => {
      const req = http.request({
         host: '127.0.0.1', port, path: '/ai-chat/ws',
         headers: {
            'Connection': 'Upgrade', 'Upgrade': 'websocket',
            'Sec-WebSocket-Key': crypto.randomBytes(16).toString('base64'),
            'Sec-WebSocket-Version': '13',
            'Cookie': token ? ('ai-chat-auth=' + token) : ''
         }
      });
      req.on('upgrade', () => resolve(false));
      req.on('response', (res) => resolve(res.statusCode === 401));
      req.on('error', () => resolve(false));
      req.end();
   });
}

// ---------------------------------------------------------------------------
// Launch backend (stdin/stdout wired to mock C++ rsession)
// ---------------------------------------------------------------------------

function startBackend(env) {
   return new Promise((resolve, reject) => {
      const mock = new MockRSession();
      const child = spawn(process.execPath, [
         MAIN, '-h', '127.0.0.1', '-p', '0', '--workspace', process.cwd()
      ], { env: Object.assign({}, process.env, env) });

      let out = '';
      const timer = setTimeout(() => reject(new Error('backend did not start; output:\n' + out)), 10000);
      child.stdout.on('data', (d) => {
         out += d.toString();
         const m = /RSTUDIO_AI_BACKEND_LISTENING (\d+)/.exec(out);
         if (m) { clearTimeout(timer); resolve({ child, port: parseInt(m[1], 10), mock }); }
      });
      child.stderr.on('data', (d) => { /* logs */ });
      child.stdin.on('drain', () => { /* ignore */ });
      mock._onMessage = (framedText) => {
         try { child.stdin.write(framedText); } catch (e) { /* child closed */ }
      };
      child.on('exit', (code) => { if (code !== 0) { clearTimeout(timer); reject(new Error('backend exited ' + code + ':\n' + out)); } });
   });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

(async function main() {
   const env = {
      RSTUDIO_CHAT_AUTH_TOKEN: AUTH,
      // We deliberately don't set RSTUDIO_PI_API_KEY -- the agent's first
      // LLM call will fail, which is fine for the smoke test; we just
      // exercise the bridge plumbing.
      RSTUDIO_PI_PROVIDER: 'anthropic',
      RSTUDIO_PI_MODEL:    'claude-sonnet-4-20250514',
      RSTUDIO_PI_THINKING: 'off',
   };

   let b;
   try {
      b = await startBackend(env);
   } catch (e) {
      console.error('FATAL: could not start backend:', e.message);
      process.exit(2);
   }
   const { child, port, mock } = b;

   // Wire the mock to the child's stdio.
   child.stdout.on('data', (chunk) => mock.feed(chunk));
   // Initial greeting from the C++ rsession: protocol/getVersion (we don't
   // have to send this for the backend to work, but a real rsession would).
   // Sending it exercises the handler on the backend side too.
   try {
      child.stdin.write(frameMessage({
         jsonrpc: '2.0', id: 9001, method: 'protocol/getVersion', params: {}
      }));
   } catch (e) { /* ignore */ }

   try {
      // 1. Auth: wrong token rejected.
      check('rejects connection with wrong auth token',
            await expectUnauthorized(port, 'wrong'));

      // 2. Happy path: connect, ready handshake.
      const api = await wsConnect(port, AUTH);
      const ready = await collect(api, { until: (m) => m.type === 'ready', timeout: 4000 });
      const readyMsg = ready.find((m) => m.type === 'ready');
      check('sends ready handshake', !!readyMsg);
      check('reports configured = true', readyMsg && readyMsg.configured === true);
      check('reports agent mode (isAgent flag)', readyMsg && readyMsg.isAgent === true);
      check('reports provider/model',
            readyMsg && /\/claude-sonnet/.test(readyMsg.model || ''));

      // 3. Discovery round-trip (client must request it).
      //    Set up the listener BEFORE sending the request, otherwise the
      //    reply can arrive before the handler is registered.
      const discPromise = collect(api, { until: (m) => m.type === 'discovery-result', timeout: 2000 });
      api.sendJSON({ type: 'get-discovery' });
      const disc = await discPromise;
      const discMsg = disc.find((m) => m.type === 'discovery-result');
      check('responds to get-discovery', !!discMsg);
      check('discovery advertises configured model',
            discMsg && /claude-sonnet/.test(discMsg.model?.model || ''));

      // 4. Health endpoint.
      const health = await new Promise((resolve) => {
         http.get('http://127.0.0.1:' + port + '/healthz', (res) => {
            let body = '';
            res.on('data', (c) => body += c);
            res.on('end', () => resolve({ status: res.statusCode, body }));
         }).on('error', () => resolve({ status: 0, body: '' }));
      });
      check('health endpoint returns 200', health.status === 200);
      const hb = (() => { try { return JSON.parse(health.body); } catch (e) { return {}; } })();
      // Agent may or may not be initialised (depends on whether Pi Agent
      // could resolve a model); we don't fail the test either way, just
      // report it.
      console.log('       health.body=' + health.body);

      // 5. Optional: round-trip a chat message. This will fail without a
      //    real API key, but it exercises the bridge plumbing up to the
      //    Pi Agent call.
      if (process.env.SMOKE_TEST_CHAT === '1') {
         api.sendJSON({ type: 'chat', requestId: 'r1',
                        messages: [{ role: 'user', content: 'Hi' }] });
         const stream = await collect(api, { until: (m) =>
            (m.type === 'done' || m.type === 'error') && m.requestId === 'r1',
            timeout: 10000 });
         const hasDelta = stream.some((m) => m.type === 'delta' || m.type === 'thinking');
         const hasError = stream.some((m) => m.type === 'error');
         check('chat turn produced events (delta/thinking/error)', hasDelta || hasError);
      } else {
         console.log('SKIP  - chat turn (set SMOKE_TEST_CHAT=1 to enable; requires a real LLM key)');
      }

      api.close();
   } catch (e) {
      console.error('test crashed:', e.stack || e);
      failures++;
   } finally {
      child.kill('SIGTERM');
   }

   console.log('\n' + (failures === 0 ? 'ALL CHECKS PASSED' : (failures + ' CHECK(S) FAILED')));
   process.exit(failures === 0 ? 0 : 1);
})();
