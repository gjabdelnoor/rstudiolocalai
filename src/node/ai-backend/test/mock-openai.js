/*
 * mock-openai.js
 *
 * A tiny OpenAI-compatible /v1/chat/completions server used to exercise the
 * backend without a real provider. Streams a canned reply (and, when the
 * request includes reasoning_effort, a reasoning delta) as Server-Sent Events.
 *
 * Usable as a module (startMockServer) or standalone (node mock-openai.js).
 */
'use strict';

const http = require('http');

function startMockServer(opts) {
   opts = opts || {};
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

            const send = (obj) => res.write('data: ' + JSON.stringify(obj) + '\n\n');
            const mkDelta = (delta) => ({
               id: 'chatcmpl-mock', object: 'chat.completion.chunk',
               model: parsed.model || 'mock', choices: [{ index: 0, delta: delta, finish_reason: null }]
            });

            // Reasoning first (only if the client asked for it).
            if (parsed.reasoning_effort) {
               send(mkDelta({ reasoning_content: 'Let me think about that. ' }));
            }

            const reply = (opts.reply || 'Hello from the mock model!').split(' ');
            let i = 0;
            const tick = () => {
               if (i < reply.length) {
                  const word = reply[i] + (i < reply.length - 1 ? ' ' : '');
                  send(mkDelta({ content: word }));
                  i++;
                  setTimeout(tick, 5);
               } else {
                  res.write('data: [DONE]\n\n');
                  res.end();
               }
            };
            tick();
         });
      });

      server.listen(opts.port || 0, '127.0.0.1', () => {
         const port = server.address().port;
         resolve({ url: `http://127.0.0.1:${port}/v1`, port, close: () => server.close() });
      });
   });
}

module.exports = { startMockServer };

if (require.main === module) {
   startMockServer({ port: process.env.PORT ? parseInt(process.env.PORT, 10) : 0 })
      .then((s) => console.log('mock OpenAI listening at ' + s.url));
}
