# RStudio AI backend (Pi Agent bridge)

The backend process that powers the RStudio **AI** pane. Hosts a [Pi coding
agent](https://github.com/earendil-works/pi-mono) session in-process and
exposes a curated set of R tools that talk to the live R kernel via JSON-RPC
2.0 over stdio. Replaces the previous OpenAI-compatible bridge -- no Posit
account, sign-in, or telemetry is involved.

## Layout

```
package.json           # declares the @earendil-works/pi-coding-agent dep
protocol.json          # { "protocol": "11.0", "backend": "pi-agent" }
dist/
  csp.json             # Content-Security-Policy directives for the UI
  server/main.js       # the backend process RStudio launches
  client/              # the chat UI served in the AI pane iframe
    index.html
    app.js
    style.css
test/
  mock-openai.js       # legacy OpenAI mock (kept for smoke test compatibility)
  smoke.js             # end-to-end test of the WebSocket handshake
```

The backend requires Node.js >= 18 and a working `npm` (for the post-install
fetch of Pi Agent). After `npm install` (run by `scripts/install-ai-backend.sh`)
the directory contains a populated `node_modules/` with Pi Agent and its
runtime deps.

## Architecture

```
+-------------------+   stdio (JSON-RPC 2.0)   +------------------------+
|  rsession (C++)   | <----------------------> | dist/server/main.js    |
|                   |                          |                        |
| R kernel helpers  |                          | - WebSocket server     |
| SessionChat.R     |                          | - HTTP static server   |
| (chat.safeEval,   |                          | - JSON-RPC 2.0 client  |
|  isFileReadAllowed)|                          | - Pi Agent host        |
+-------------------+                          |   (createAgentSession) |
                                                | - Custom R tools       |
                                                |   (r_execute,          |
                                                |    r_list_variables,  |
                                                |    r_get_dataframe,    |
                                                |    r_read_console,     |
                                                |    r_open_file)        |
                                                | - Guardrail extension  |
                                                |   (destructive R &     |
                                                |    built-in tools)     |
                                                +-----------+------------+
                                                            |
                                       WebSocket (RFC 6455) |
                                                            v
                                                +------------------------+
                                                | Browser iframe (GWT)   |
                                                | dist/client/app.js     |
                                                +------------------------+
```

The agent (Pi Agent's LLM + tool loop) is the brain. The C++ rsession is the
muscle. The backend is the nervous system. The user's chat panel is the face.

## Configuration

RStudio sets these environment variables from your preferences when it
launches the backend:

| Variable | Meaning | Default |
| --- | --- | --- |
| `RSTUDIO_PI_PROVIDER` | Pi Agent provider name (anthropic, openai, google, ollama, ...) | ollama if active=local, else anthropic |
| `RSTUDIO_PI_MODEL` | Model ID (`claude-sonnet-4-20250514`, `gpt-4o`, `gemini-2.5-pro`, `llama3.2`, ...) | `claude-sonnet-4-20250514` |
| `RSTUDIO_PI_THINKING` | `off` / `minimal` / `low` / `medium` / `high` / `xhigh` | `medium` |
| `RSTUDIO_PI_API_KEY` | LLM API key (also read from `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, etc. by Pi) | _empty_ |
| `RSTUDIO_PI_BASE_URL` | Override provider base URL (for self-hosted: Ollama, vLLM, LM Studio) | _empty_ |
| `RSTUDIO_PI_WORKSPACE` | Working directory (R session's CWD) | rsession's CWD |
| `RSTUDIO_CHAT_AUTH_TOKEN` | Per-session WebSocket auth token (set by RStudio) | _empty_ |

## Tools available to the agent

The backend registers exactly five tools with the Pi Agent. **All of Pi
Agent's built-in tools (read, write, edit, bash, grep, find, ls) are
disabled** -- this is the strongest possible guardrail. The agent cannot
run arbitrary shell commands, write arbitrary files, or read the filesystem
on its own. The only way it can affect the outside world is through the
curated R tools below.

| Tool | Description | Destructive? |
| --- | --- | --- |
| `r_execute` | Run R code in the live R session | Yes -- confirmation required for `unlink`, `system(rm ...)`, `install.packages`, `options()`, `setwd()`, `writeLines`, etc. |
| `r_list_variables` | List top-level R variables | No |
| `r_get_dataframe` | Inspect an R data frame (class, dim, head) | No |
| `r_read_console` | Read recent R console output | No |
| `r_open_file` | Open a file in the RStudio editor | No |

The guardrail extension's `tool_call` event handler examines the proposed R
code and, if it matches a destructive pattern, sends a `confirmation-request`
to the chat client. The user must approve before the call proceeds. Patterns
flagged as destructive include:

- R-level: `unlink`, `file.remove`, `file.rename`, `system("rm ...")`, `dir.create`, `assign(..., GlobalEnv)`, `options()`, `Sys.setenv`, `Sys.unsetenv`, `install.packages`, `remove.packages`, `detach("package:...")`, `unloadNamespace`, `setwd`, `writeLines`, `write.csv`, `write.table`, `saveRDS`, `save(image=...)`
- Shell-level (when wrapped in `system()` / `system2()`): `rm -rf`, `sudo`, `dd if=`, `mkfs`, `chmod -R 000`, `curl ... | bash`, `wget ... | sh`

## WebSocket protocol

The chat client UI speaks the same JSON-over-WebSocket protocol as the
previous OpenAI bridge, with one addition:

- `confirmation-request` (server -> client): asks the user to confirm a
  destructive R call. The client must respond with
  `confirmation-response` containing the same `confirmationId` and a
  `confirmed: true|false` field.

Server -> client: `ready`, `thinking`, `delta`, `done`, `error`,
`discovery-result`, `confirmation-request`
Client -> server: `ping`, `chat`, `refresh-discovery`, `get-discovery`,
`confirmation-response`

## Using it with RStudio

RStudio locates the backend in this order:

1. `RSTUDIO_AI_CHAT_PATH` environment variable (point it at this directory)
2. a bundled copy under the RStudio installation
3. `$XDG_DATA_HOME/pai/bin` (user) or the system config dir

The simplest way to try it against a local build is to export the path:

```sh
export RSTUDIO_AI_CHAT_PATH=/path/to/rstudio/src/node/ai-backend
```

then open the **AI** pane in RStudio.

## Running standalone / testing

```sh
RSTUDIO_PI_PROVIDER=anthropic \
RSTUDIO_PI_MODEL=claude-sonnet-4-20250514 \
ANTHROPIC_API_KEY=sk-ant-... \
node dist/server/main.js -h 127.0.0.1 -p 8765
# then open http://127.0.0.1:8765/ in a browser
```

Run the end-to-end smoke test:

```sh
node test/smoke.js
# or: npm test
```

The smoke test verifies the WebSocket handshake, auth enforcement, the
`ready` config message, and the discovery round-trip. It does **not** make a
real LLM call (that requires provider credentials); it tests the bridge
plumbing up to the point where Pi Agent would handle the chat turn.
