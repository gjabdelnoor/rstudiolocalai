# RStudio AI backend (OpenAI-compatible)

A small, self-hosted chat backend that powers the RStudio **AI** pane using any
OpenAI-compatible `/v1/chat/completions` endpoint. It replaces the proprietary
"Posit Assistant" backend, so **no Posit account, sign-in, or telemetry is
involved** -- you bring your own endpoint and key.

It works with OpenAI, Azure OpenAI (v1 surface), Together, Groq, OpenRouter,
and local servers such as Ollama, LM Studio, llama.cpp, and vLLM -- anything
that speaks the OpenAI legacy v1 chat-completions API.

## Layout

This directory matches the installation layout RStudio expects (see
`src/cpp/session/modules/chat/`):

```
package.json
protocol.json            # { "protocol": "10.0" }
dist/
  csp.json               # Content-Security-Policy directives for the UI
  server/main.js         # the backend process RStudio launches
  client/                # the chat UI served in the AI pane iframe
    index.html
    app.js
    style.css
test/
  mock-openai.js         # an OpenAI-compatible mock server
  smoke.js               # end-to-end test (no external dependencies)
```

The backend is intentionally **dependency-free** -- it uses only Node.js
built-ins plus the global `fetch()` in Node 18+. There is nothing to `npm
install`; it runs directly under the Node.js that ships with RStudio.

## Configuration

RStudio sets these environment variables from your preferences
(**Tools > Global Options > AI**, or the AI pane's settings screen) when it
launches the backend:

| Variable | Meaning | Default |
| --- | --- | --- |
| `RSTUDIO_AI_API_KEY` | Bearer API key (omit for local servers that need none) | _empty_ |
| `RSTUDIO_AI_BASE_URL` | API base URL | `https://api.openai.com/v1` |
| `RSTUDIO_AI_MODEL` | Model name | `gpt-4o` |
| `RSTUDIO_AI_THINKING` | `1`/`0` -- request and display reasoning | `0` |
| `RSTUDIO_AI_INTERLEAVED_THINKING` | `1`/`0` -- stream reasoning inline vs. collapsed | `0` |
| `RSTUDIO_AI_MAX_CONTEXT` | Max context window (tokens) used to trim history | `128000` |
| `RSTUDIO_CHAT_AUTH_TOKEN` | Per-session WebSocket auth token (set by RStudio) | _empty_ |

As a fallback, the `--config <file>` JSON passed by RStudio may carry the same
fields under a top-level object or an `ai` / `openai` key.

**Thinking** sends `reasoning_effort` on the request and surfaces any
`reasoning_content` / `reasoning` deltas the provider returns (works with
reasoning-capable models; harmless otherwise). **Interleaved thinking**
controls whether that reasoning streams inline (on) or in a collapsed
"Reasoning" block (off).

## Using it with RStudio

RStudio locates the backend in this order:

1. `RSTUDIO_POSIT_AI_PATH` environment variable (point it at this directory)
2. a bundled copy under the RStudio installation
3. `$XDG_DATA_HOME/pai/bin` (user) or the system config dir

The simplest way to try it against a local build is to export the path:

```sh
export RSTUDIO_POSIT_AI_PATH=/path/to/rstudio/src/node/ai-backend
```

then open the **AI** pane in RStudio.

## Running standalone / testing

Run the backend directly (it also serves the client UI for convenience):

```sh
RSTUDIO_AI_BASE_URL=http://localhost:11434/v1 \
RSTUDIO_AI_MODEL=llama3.1 \
node dist/server/main.js -h 127.0.0.1 -p 8765

# then open http://127.0.0.1:8765/ in a browser
```

Run the end-to-end smoke test (starts a mock provider, launches the backend,
drives a real WebSocket session):

```sh
node test/smoke.js
# or: npm test
```
