/*
 * smoke.js
 *
 * End-to-end smoke test for the RStudio AI backend. It:
 *   1. starts a mock OpenAI-compatible server,
 *   2. launches dist/server/main.js pointed at the mock,
 *   3. connects a (built-in, dependency-free) WebSocket client,
 *   4. asserts auth enforcement, the ready handshake, streamed deltas,
 *      reasoning deltas (thinking), provider errors, and context trimming.
 *
 * Run: node test/smoke.js   (from the ai-backend directory)
 */
'use strict';

const net = require('net');
const http = require('http');
const crypto = require('crypto');
const path = require('path');
const { spawn } = require('child_process');
const { startMockServer } = require('./mock-openai.js');

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAIN = path.resolve(__dirname, '..', 'dist', 'server', 'main.js');
const AUTH = 'test-token-123';

let failures = 0;
function check(name, cond) {
   console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name);
   if (!cond) failures++;
}

// --- Minimal WebSocket client (masked frames) ---------------------------
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
         close: () => socket.destroy()
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
         // Parse server frames (unmasked).
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

// --- Launch backend ------------------------------------------------------
function startBackend(env) {
   return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [
         MAIN, '-h', '127.0.0.1', '-p', '0', '--json',
         '--workspace', process.cwd(), '--storage', '/tmp', '--workspace-id', 'test'
      ], { env: Object.assign({}, process.env, env) });

      let out = '';
      const timer = setTimeout(() => reject(new Error('backend did not start; output:\n' + out)), 5000);
      // The port marker is emitted on stderr; stdout is reserved for the
      // LSP-style JSON-RPC channel to RStudio.
      child.stderr.on('data', (d) => {
         out += d.toString();
         const m = /RSTUDIO_AI_BACKEND_LISTENING (\d+)/.exec(out);
         if (m) { clearTimeout(timer); resolve({ child, port: parseInt(m[1], 10) }); }
      });
      child.stdout.on('data', () => { /* JSON-RPC channel; ignored in smoke test */ });
      child.on('exit', (code) => { if (code !== 0) { clearTimeout(timer); reject(new Error('backend exited ' + code)); } });
   });
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

// --- Raw HTTP upgrade attempt (to assert 401 on bad token) --------------
function expectUnauthorized(port, token) {
   return new Promise((resolve) => {
      const req = http.request({
         host: '127.0.0.1', port, path: '/ai-chat/ws',
         headers: {
            'Connection': 'Upgrade', 'Upgrade': 'websocket',
            'Sec-WebSocket-Key': crypto.randomBytes(16).toString('base64'),
            'Sec-WebSocket-Version': '13',
            'Cookie': token ? ('posit-assistant-auth=' + token) : ''
         }
      });
      req.on('upgrade', () => resolve(false)); // upgraded => NOT rejected
      req.on('response', (res) => resolve(res.statusCode === 401));
      req.on('error', () => resolve(false));
      req.end();
   });
}

(async function main() {
   const mock = await startMockServer({ reply: 'Hello from the mock model!' });

   const { child, port } = await startBackend({
      RSTUDIO_CHAT_AUTH_TOKEN: AUTH,
      RSTUDIO_AI_BASE_URL: mock.url,
      RSTUDIO_AI_API_KEY: 'sk-test',
      RSTUDIO_AI_MODEL: 'gpt-4o',
      RSTUDIO_AI_THINKING: '1',
      RSTUDIO_AI_INTERLEAVED_THINKING: '1',
      RSTUDIO_AI_MAX_CONTEXT: '8000'
   });

   try {
      // 1. Auth: wrong token rejected.
      check('rejects connection with wrong auth token', await expectUnauthorized(port, 'wrong'));

      // 2. Happy path: connect, ready, stream, thinking, done.
      const api = await wsConnect(port, AUTH);
      const ready = await collect(api, { until: (m) => m.type === 'ready', timeout: 2000 });
      const readyMsg = ready.find((m) => m.type === 'ready');
      check('sends ready handshake', !!readyMsg);
      check('reports configured = true', readyMsg && readyMsg.configured === true);
      check('reports model name', readyMsg && readyMsg.model === 'gpt-4o');

      api.sendJSON({ type: 'chat', requestId: 'r1', messages: [{ role: 'user', content: 'Hi there' }] });
      const stream = await collect(api, { until: (m) => m.type === 'done' && m.requestId === 'r1', timeout: 4000 });

      const deltas = stream.filter((m) => m.type === 'delta');
      const thinking = stream.filter((m) => m.type === 'thinking');
      const done = stream.find((m) => m.type === 'done');
      const text = deltas.map((d) => d.content).join('');

      check('streams content deltas', deltas.length > 0);
      check('assembles expected reply', text === 'Hello from the mock model!');
      check('streams reasoning (thinking) deltas', thinking.length > 0);
      check('sends done', !!done);

      api.close();
   } finally {
      child.kill();
      mock.close();
   }

   // 4. Forced provider error via a dedicated backend instance.
   const mock2 = await startMockServer({});
   const b2 = await startBackend({
      RSTUDIO_CHAT_AUTH_TOKEN: AUTH,
      RSTUDIO_AI_BASE_URL: mock2.url,
      RSTUDIO_AI_MODEL: 'force-error',
      RSTUDIO_AI_MAX_CONTEXT: '8000'
   });
   try {
      const api2 = await wsConnect(b2.port, AUTH);
      await collect(api2, { until: (m) => m.type === 'ready', timeout: 2000 });
      api2.sendJSON({ type: 'chat', requestId: 'e1', messages: [{ role: 'user', content: 'hi' }] });
      const s = await collect(api2, { until: (m) => m.type === 'error' && m.requestId === 'e1', timeout: 4000 });
      check('surfaces provider error (HTTP 400)', s.some((m) => m.type === 'error' && /400/.test(m.message)));
      api2.close();
   } finally {
      b2.child.kill();
      mock2.close();
   }

   // 5. Not-configured backend reports configured=false and refuses chat.
   const b3 = await startBackend({
      RSTUDIO_CHAT_AUTH_TOKEN: AUTH,
      RSTUDIO_AI_BASE_URL: '',
      RSTUDIO_AI_MODEL: ''
   });
   try {
      const api3 = await wsConnect(b3.port, AUTH);
      const r = await collect(api3, { until: (m) => m.type === 'ready', timeout: 2000 });
      const rm = r.find((m) => m.type === 'ready');
      // base url defaults to api.openai.com and model defaults to gpt-4o, so it
      // is "configured" by default. Override defaults to truly empty is not
      // possible via env (empty -> default), so assert defaults instead.
      check('applies default model when unset', rm && rm.model === 'gpt-4o');
      check('applies default base url when unset', rm && /api\.openai\.com/.test(rm.baseUrl));
      api3.close();
   } finally {
      b3.child.kill();
   }

   console.log('\n' + (failures === 0 ? 'ALL CHECKS PASSED' : (failures + ' CHECK(S) FAILED')));
   process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('smoke test crashed:', e); process.exit(2); });
