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
  smoke.js               # end-to-end chat/streaming test
  agent.js               # end-to-end agent tool-loop + guardrails test
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

## Agent tool-loop (R kernel access)

Modeled on the [Pi coding agent](https://github.com/earendil-works/pi), the
backend runs a tool-calling loop that lets the model drive the live R session.
When RStudio is connected on the JSON-RPC channel (see below), the model is
offered three tools and the backend loops -- streaming text, running the tools,
feeding results back -- until the model stops calling them (capped at 8 rounds):

| Tool | Purpose | Guarded |
| --- | --- | --- |
| `run_r_code` | Execute R in the user's session (compute, transform, load/inspect data frames) | yes |
| `inspect_data` | Read-only `str()`/`dim()`/`head()` of an object or data frame | no |
| `read_workspace` | List global-environment variables and open editor files | no |

### Destructive-action guardrails

Before any `run_r_code` runs, the code is classified:

- **block** -- catastrophic, irreversible system harm (e.g. `system("rm -rf ...")`,
  recursive `unlink(..., recursive = TRUE)`). Never executed; the model is told
  it was blocked.
- **confirm** -- destructive but legitimate (deleting/renaming/writing files,
  `rm(list = ls())`, shell commands, `install.packages`, destructive SQL,
  `download.file`, quitting R, `setwd`). The backend emits a `confirmRequired`
  event and waits for the user's `confirmResponse` (default-deny after 120s)
  before running.
- **allow** -- everything else runs immediately.

### RStudio JSON-RPC channel

Tools are executed by calling RStudio over an LSP-style (Content-Length framed)
JSON-RPC channel on the process's **stdin/stdout** (stdout is reserved for the
frames; logs and the port marker go to stderr). The RStudio C++ session side
(`src/cpp/session/modules/SessionChat.cpp`) implements the peer end and answers:

| Method | Params | Result |
| --- | --- | --- |
| `protocol/getVersion` | `{ clientProtocolVersion, clientVersion, capabilities }` | `{ protocolVersion, rstudioVersion, capabilities }` |
| `runtime/getDetailedContext` | _none_ | `{ session{ version, sessionId, variables[], variablesMeta }, openFiles[], platformInfo }` |
| `runtime/executeCode` | `{ language: "r", code, trackingId, options }` | `{ output, error, canceled, plots, executionTime }` |
| `workspace/insertAtCursor` | `{ content }` | `{ success }` |
| `workspace/insertIntoNewFile` | `{ content, languageId }` | `{ success }` |

RStudio's C++ side is purely reactive (it never sends an unsolicited message),
so on startup the backend initiates a `protocol/getVersion` handshake. The reply
both marks RStudio connected (enabling the tool loop) and reports RStudio's
capabilities -- tools whose underlying method is unsupported are not offered.
When capabilities are omitted, full compatibility is assumed. With no peer
(standalone / tests) the handshake simply times out and the backend stays in
plain-chat mode. The protocol version (`10.0`) tracks
`src/cpp/session/modules/chat/ChatConstants.cpp`.

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

Run the end-to-end tests (each starts a mock provider, launches the backend,
and drives a real WebSocket session; `agent.js` also attaches a fake RStudio
JSON-RPC peer to exercise the tool-loop and guardrails):

```sh
node test/smoke.js     # chat + streaming
node test/agent.js     # agent tool-loop + destructive-action guardrails
# or run both: npm test
```
