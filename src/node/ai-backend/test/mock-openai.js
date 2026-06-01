/*
 * mock-openai.js
 *
 * A tiny OpenAI-compatible /v1/chat/completions server used to exercise the
 * backend without a real provider. Streams a canned reply (and, when the
 * request includes reasoning_effort, a reasoning delta) as Server-Sent Events.
 *
 * Two modes:
 *   - default: streams opts.reply word-by-word (plus a reasoning delta when
 *     the request asked for reasoning_effort).
 *   - scripted: opts.script is an array of turns consumed one per request, so
 *     the agent tool-loop can be driven deterministically. Each turn is either
 *       { toolCall: { id?, name, arguments } }   -> emit a tool call
 *       { content: 'text' }                      -> stream assistant text
 *
 * Usable as a module (startMockServer) or standalone (node mock-openai.js).
 */
'use strict';

const http = require('http');

function startMockServer(opts) {
   opts = opts || {};
   let turnIndex = 0;
   const requests = []; // captured request bodies, for assertions
   return new Promise((resolve) => {
      const server = http.createServer((req, res) => {
         if (req.method !== 'POST' || !req.url.endsWith('/chat/completions')) {
            res.writeHead(404); res.end('not found'); return;
         }
         let body = '';
         req.on('data', (c) => { body += c; });
         req.on('end', () => {
            let parsed = {};
            try { parsed = JSON.parse(body); } catch (e) { /* ignore */ }
            requests.push(parsed);

            // Allow tests to force an error response.
            if (parsed.model === 'force-error') {
               res.writeHead(400, { 'Content-Type': 'application/json' });
               res.end(JSON.stringify({ error: { message: 'forced error for testing' } }));
               return;
            }

            res.writeHead(200, {
               'Content-Type': 'text/event-stream',
               'Cache-Control': 'no-cache',
               'Connection': 'keep-alive'
            });

            const model = parsed.model || 'mock';
            const send = (obj) => res.write('data: ' + JSON.stringify(obj) + '\n\n');
            const mkChunk = (delta, finish) => ({
               id: 'chatcmpl-mock', object: 'chat.completion.chunk',
               model, choices: [{ index: 0, delta: delta, finish_reason: finish || null }]
            });
            const streamWords = (text, done) => {
               const words = String(text || '').split(' ');
               let i = 0;
               const tick = () => {
                  if (i < words.length) {
                     const word = words[i] + (i < words.length - 1 ? ' ' : '');
                     send(mkChunk({ content: word }));
                     i++;
                     setTimeout(tick, 3);
                  } else {
                     if (done) done();
                     res.write('data: [DONE]\n\n');
                     res.end();
                  }
               };
               tick();
            };

            // Scripted mode: consume one turn per request.
            if (Array.isArray(opts.script)) {
               const turn = opts.script[Math.min(turnIndex, opts.script.length - 1)];
               turnIndex++;
               if (turn && turn.toolCall) {
                  const tc = turn.toolCall;
                  const args = typeof tc.arguments === 'string'
                     ? tc.arguments : JSON.stringify(tc.arguments || {});
                  send(mkChunk({
                     tool_calls: [{
                        index: 0, id: tc.id || ('call_' + turnIndex), type: 'function',
                        function: { name: tc.name, arguments: args }
                     }]
                  }));
                  send(mkChunk({}, 'tool_calls'));
                  res.write('data: [DONE]\n\n');
                  res.end();
                  return;
               }
               streamWords((turn && turn.content) || '');
               return;
            }

            // Default mode: optional reasoning, then the canned reply.
            if (parsed.reasoning_effort) {
               send(mkChunk({ reasoning_content: 'Let me think about that. ' }));
            }
            streamWords(opts.reply || 'Hello from the mock model!');
         });
      });

      server.listen(opts.port || 0, '127.0.0.1', () => {
         const port = server.address().port;
         resolve({ url: `http://127.0.0.1:${port}/v1`, port, requests, close: () => server.close() });
      });
   });
}

module.exports = { startMockServer };

if (require.main === module) {
   startMockServer({ port: process.env.PORT ? parseInt(process.env.PORT, 10) : 0 })
      .then((s) => console.log('mock OpenAI listening at ' + s.url));
}
