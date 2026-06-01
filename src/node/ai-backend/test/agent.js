/*
 * agent.js
 *
 * Tests the Pi-style agent tool-loop and the destructive-action guardrails.
 *
 * It stands up:
 *   1. a scripted mock OpenAI server (emits tool calls, then a final answer),
 *   2. the backend (dist/server/main.js) pointed at the mock,
 *   3. a fake RStudio JSON-RPC peer on the backend's stdin/stdout that answers
 *      runtime/getDetailedContext and runtime/executeCode and records calls,
 *   4. a WebSocket chat client.
 *
 * Then it asserts, across four scenarios:
 *   - a safe tool call executes and the loop continues to a final answer,
 *   - a destructive tool call prompts confirmation and, when DENIED, is not run,
 *   - a destructive tool call, when APPROVED, is run,
 *   - a catastrophic tool call is hard-blocked (no prompt, never run).
 *
 * Run: node test/agent.js   (from the ai-backend directory)
 */
'use strict';

const net = require('net');
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
         socket.write(
            'GET /ai-chat/ws?token=' + encodeURIComponent(token) + ' HTTP/1.1\r\n' +
            'Host: 127.0.0.1:' + port + '\r\n' +
            'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
            'Sec-WebSocket-Key: ' + key + '\r\nSec-WebSocket-Version: 13\r\n\r\n');
      });
      let handshakeDone = false;
      let buf = Buffer.alloc(0);
      const handlers = [];
      const api = {
         onMessage: (fn) => handlers.push(fn),
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
            if (!/101/.test(head.split('\r\n')[0])) { reject(new Error('handshake failed')); socket.destroy(); return; }
            handshakeDone = true;
            resolve(api);
         }
         for (;;) {
            const frame = parseServerFrame(buf);
            if (!frame) break;
            buf = frame.rest;
            if (frame.opcode === 0x1) handlers.forEach((fn) => fn(frame.payload.toString('utf8')));
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

// --- Fake RStudio JSON-RPC peer over the backend's stdin/stdout ----------
function attachRStudioPeer(child, handlers) {
   const peer = { executeCalls: [], executeParams: [], contextCalls: 0, handshakeParams: null };
   let buf = Buffer.alloc(0);

   function writeFrame(obj) {
      const body = JSON.stringify(obj);
      child.stdin.write('Content-Length: ' + Buffer.byteLength(body, 'utf8') + '\r\n\r\n' + body);
   }

   child.stdout.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
         const sep = buf.indexOf('\r\n\r\n');
         if (sep === -1) break;
         const header = buf.slice(0, sep).toString('utf8');
         const m = /Content-Length:\s*(\d+)/i.exec(header);
         if (!m) { buf = buf.slice(sep + 4); continue; }
         const len = parseInt(m[1], 10);
         const start = sep + 4;
         if (buf.length < start + len) break;
         const body = buf.slice(start, start + len).toString('utf8');
         buf = buf.slice(start + len);
         let req; try { req = JSON.parse(body); } catch (e) { continue; }
         if (req.method && req.id !== undefined) {
            const handler = handlers[req.method];
            let result = handler ? handler(req.params || {}, peer) : {};
            Promise.resolve(result).then((r) => writeFrame({ jsonrpc: '2.0', id: req.id, result: r }));
         }
      }
   });

   // No unsolicited frames: like the real RStudio C++ side, this peer is purely
   // reactive. The backend initiates the protocol/getVersion handshake, whose
   // reply is what marks it connected.
   return peer;
}

const RSTUDIO_CAPS = [
   'runtime/getActiveSession', 'runtime/getDetailedContext', 'runtime/executeCode',
   'runtime/getConsoleContent', 'workspace/insertIntoNewFile', 'workspace/insertAtCursor'
];

const DEFAULT_HANDLERS = {
   'protocol/getVersion': (params, peer) => {
      peer.handshakeParams = params;
      return { protocolVersion: '10.0', rstudioVersion: 'test', capabilities: RSTUDIO_CAPS };
   },
   'runtime/getDetailedContext': (params, peer) => {
      peer.contextCalls++;
      return {
         session: { version: '4.3.1', sessionId: 'abcdef1234',
                    variables: [{ name: 'mtcars', type: 'data.frame' }] },
         openFiles: [],
         platformInfo: { currentDate: '2026-06-01' }
      };
   },
   'runtime/executeCode': (params, peer) => {
      peer.executeCalls.push(params.code);
      peer.executeParams.push(params);
      return { output: 'OK: ' + (params.code || '').slice(0, 40), error: '' };
   }
};

function startBackend(env) {
   return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [
         MAIN, '-h', '127.0.0.1', '-p', '0', '--json',
         '--workspace', process.cwd(), '--storage', '/tmp', '--workspace-id', 'test'
      ], { env: Object.assign({}, process.env, env) });
      let out = '';
      const timer = setTimeout(() => reject(new Error('backend did not start; ' + out)), 5000);
      child.stderr.on('data', (d) => {
         out += d.toString();
         const m = /RSTUDIO_AI_BACKEND_LISTENING (\d+)/.exec(out);
         if (m) { clearTimeout(timer); resolve({ child, port: parseInt(m[1], 10) }); }
      });
      child.on('exit', (code) => { if (code !== 0 && code !== null) { clearTimeout(timer); reject(new Error('exited ' + code)); } });
   });
}

// Collect messages until 'done'/'error'; auto-answer confirmRequired per decision.
function runChat(api, decision) {
   return new Promise((resolve) => {
      const msgs = [];
      const t = setTimeout(() => resolve(msgs), 8000);
      api.onMessage((str) => {
         let m; try { m = JSON.parse(str); } catch (e) { return; }
         msgs.push(m);
         if (m.type === 'confirmRequired' && decision !== undefined) {
            api.sendJSON({ type: 'confirmResponse', callId: m.callId, approved: decision });
         }
         if (m.type === 'done' || m.type === 'error') { clearTimeout(t); setTimeout(() => resolve(msgs), 50); }
      });
   });
}

function assembleText(msgs) {
   return msgs.filter((m) => m.type === 'delta').map((m) => m.content).join('');
}

async function scenario(name, { script, decision }) {
   const mock = await startMockServer({ script });
   const { child, port } = await startBackend({
      RSTUDIO_CHAT_AUTH_TOKEN: AUTH,
      RSTUDIO_AI_BASE_URL: mock.url,
      RSTUDIO_AI_API_KEY: 'sk-test',
      RSTUDIO_AI_MODEL: 'gpt-4o',
      RSTUDIO_AI_THINKING: '0',
      RSTUDIO_AI_MAX_CONTEXT: '8000'
   });
   const peer = attachRStudioPeer(child, DEFAULT_HANDLERS);
   await new Promise((r) => setTimeout(r, 150)); // let the init frame land
   const api = await wsConnect(port, AUTH);
   await new Promise((r) => { const t = setTimeout(r, 1500); api.onMessage((s) => { try { if (JSON.parse(s).type === 'ready') { clearTimeout(t); r(); } } catch (e) {} }); });
   api.sendJSON({ type: 'chat', requestId: 'r1', messages: [{ role: 'user', content: 'help me' }] });
   const result = await runChat(api, decision);
   api.close();
   try { child.kill(); } catch (e) {}
   mock.close();
   return { msgs: result, peer };
}

(async function main() {
   // A) Safe tool call -> executes, no confirmation, loop reaches final answer.
   {
      const { msgs, peer } = await scenario('safe', {
         script: [
            { toolCall: { name: 'run_r_code', arguments: { code: 'summary(mtcars)' } } },
            { content: 'The data has 32 rows.' }
         ]
      });
      check('A: backend performed protocol/getVersion handshake', !!peer.handshakeParams);
      check('A: handshake advertised the protocol version', !!peer.handshakeParams && peer.handshakeParams.clientProtocolVersion === '10.0');
      check('A: safe code did NOT prompt for confirmation', !msgs.some((m) => m.type === 'confirmRequired'));
      check('A: run_r_code tool call surfaced to client', msgs.some((m) => m.type === 'toolCall' && m.tool === 'run_r_code'));
      check('A: code was executed in the R session', peer.executeCalls.includes('summary(mtcars)'));
      const ep = peer.executeParams[0] || {};
      check('A: executeCode used language "r"', ep.language === 'r');
      check('A: executeCode included a trackingId', typeof ep.trackingId === 'string' && ep.trackingId.length > 0);
      check('A: final answer streamed after the tool', assembleText(msgs).indexOf('32 rows') !== -1);
      check('A: turn ended with done', msgs.some((m) => m.type === 'done'));
   }

   // B) Destructive tool call, DENIED -> confirmation shown, code NOT executed.
   {
      const { msgs, peer } = await scenario('deny', {
         decision: false,
         script: [
            { toolCall: { name: 'run_r_code', arguments: { code: 'unlink("data.csv")' } } },
            { content: 'Understood, I will not delete it.' }
         ]
      });
      const conf = msgs.find((m) => m.type === 'confirmRequired');
      check('B: destructive code prompted for confirmation', !!conf);
      check('B: confirmation names the destructive reason', !!conf && /unlink|delete/i.test(conf.reason || ''));
      check('B: confirmation includes the code', !!conf && (conf.code || '').indexOf('unlink') !== -1);
      check('B: denied code was NOT executed', !peer.executeCalls.some((c) => c.indexOf('unlink') !== -1));
      check('B: turn still ended with done', msgs.some((m) => m.type === 'done'));
   }

   // C) Destructive tool call, APPROVED -> code IS executed.
   {
      const { msgs, peer } = await scenario('approve', {
         decision: true,
         script: [
            { toolCall: { name: 'run_r_code', arguments: { code: 'install.packages("dplyr")' } } },
            { content: 'Installed.' }
         ]
      });
      check('C: destructive code prompted for confirmation', msgs.some((m) => m.type === 'confirmRequired'));
      check('C: approved code WAS executed', peer.executeCalls.some((c) => c.indexOf('install.packages') !== -1));
   }

   // D) Catastrophic tool call -> hard-blocked: no prompt, never executed.
   {
      const { msgs, peer } = await scenario('block', {
         script: [
            { toolCall: { name: 'run_r_code', arguments: { code: 'system("rm -rf /tmp/x")' } } },
            { content: 'I cannot do that.' }
         ]
      });
      check('D: catastrophic code was NOT prompted (hard block)', !msgs.some((m) => m.type === 'confirmRequired'));
      check('D: catastrophic code was NOT executed', peer.executeCalls.length === 0);
      check('D: a blocked tool result was surfaced', msgs.some((m) => m.type === 'toolResult' && m.blocked));
   }

   console.log('');
   if (failures === 0) console.log('ALL CHECKS PASSED');
   else console.log(failures + ' CHECK(S) FAILED');
   process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
