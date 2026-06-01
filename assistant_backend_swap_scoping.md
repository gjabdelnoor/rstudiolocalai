# RStudio Assistant Backend Swap — Scoping Report

## 1. Repo Identity and Assistant Module Map

**CONFIRMED**: This is the `rstudio/rstudio` repo (CMake-based C++ desktop + server IDE with GWT frontend), **not** the Positron VS Code fork. The assistant code is in two independent subsystems:

- **Chat pane**: `src/cpp/session/modules/SessionChat.cpp` (+ `chat/` subdir) launches a Node.js backend and proxies WebSocket traffic between the GWT chat UI and that backend.
- **Inline completions / NES**: `src/cpp/session/modules/SessionAssistant.cpp` communicates with a language server (LSP) — either GitHub Copilot's or Posit AI's — via JSON-RPC over stdio.
- **GWT frontend**: `src/gwt/src/org/rstudio/studio/client/workbench/assistant/` (sign-in dialog, prefs pane) and `src/gwt/src/org/rstudio/studio/client/workbench/views/chat/` (chat pane UI).
- **Preferences**: `src/gwt/src/org/rstudio/studio/client/workbench/prefs/views/AssistantPreferencesPane.java` renders the AI settings UI.

## 2. The Substitution Seam

### Chat (already solved in fork)
The chat backend is launched as a child Node.js process in `SessionChat.cpp:4689` (`startChatBackend`). It locates an installation directory (`pai/bin/`), finds `dist/server/main.js`, allocates a port, and passes:
- `--config <paconfig.json>`
- `--workspace <dir>`
- `--storage <dir>`
- `--workspace-id <hash>`
- `RSTUDIO_CHAT_AUTH_TOKEN` (env)

**The substitution seam is the backend script itself**: RStudio doesn't know what's inside `dist/server/main.js`. It only expects:
1. The script to print `RSTUDIO_AI_BACKEND_LISTENING <port>` to stdout
2. The script to speak the JSON-RPC protocol defined in `protocol.json` (v10.0)
3. The script to serve static files from `dist/client/`

The fork (`rstudiolocalai`) replaced this with a 659-line dependency-free Node server (`src/node/ai-backend/dist/server/main.js`) that streams from any OpenAI-compatible `/v1/chat/completions` endpoint. It reads configuration from environment variables:
- `RSTUDIO_AI_API_KEY`
- `RSTUDIO_AI_BASE_URL`
- `RSTUDIO_AI_MODEL`
- `RSTUDIO_AI_THINKING`
- `RSTUDIO_AI_INTERLEAVED_THINKING`
- `RSTUDIO_AI_MAX_CONTEXT`

### Inline Completions (separate, harder)
Inline completions use **LSP over stdio**, not WebSocket. `SessionAssistant.cpp:2072` (`assistantGenerateCompletions`) builds a `textDocument/inlineCompletion` request and sends it to the running language server agent (Copilot or Posit AI). The agent is started in `SessionAssistant.cpp:~1250` via a helper script that launches the respective language server.

**There is no existing abstraction for a third completion backend.** The code branches on:
- `kAssistantCopilot` → Copilot language server
- `kAssistantPosit` → Posit AI language server (`pai/bin/dist/nes/`)
- `kAssistantNone` → no agent

To swap completions, you would need to either:
(a) **Add an OpenAI-compatible inline completion endpoint** to the self-hosted chat backend (it currently only handles chat, not `textDocument/inlineCompletion`), or
(b) **Create a new LSP shim** that translates `textDocument/inlineCompletion` to OpenAI-compatible requests.

## 3. Recommended Minimal Change

### For Chat (proven approach from fork)
The fork already demonstrated the least-invasive path. Replicating it on `origin/main` would require:

1. **Add `src/node/ai-backend/`** — the self-hosted OpenAI-compatible backend (already written and tested in the fork).
2. **Add 6 user preferences** (`ai_api_key`, `ai_base_url`, `ai_model`, `ai_thinking_enabled`, `ai_interleaved_thinking_enabled`, `ai_max_context_size`) to `user-prefs-schema.json` and regenerate GWT accessors.
3. **Modify `SessionChat.cpp`**:
   - Pass the 6 AI settings as environment variables to `startChatBackend` (≈15 lines).
   - Short-circuit `chatCheckForUpdates` to report "up to date" without contacting Posit's manifest (prevents the proprietary backend from being downloaded).
   - Short-circuit `chatInstallUpdate` to block downloads (defense in depth).
   - Prefer the bundled backend in `locatePositAssistantInstallation()` by checking a CMake-installed resources path first.
4. **Modify `AssistantPreferencesPane.java`** — add text fields for base URL, model, API key, plus checkboxes for thinking and max context.
5. **Add `src/node/ai-backend/` to `src/cpp/session/CMakeLists.txt`** so it installs into the session resources directory.

### For Inline Completions
This is **not solved** in the fork. The fork only made telemetry no-ops (`assistantDidShowCompletion`, `assistantDidAcceptPartialCompletion`).

Options:
- **Option A (recommended if you need it)**: Extend the self-hosted `ai-backend` to also handle `textDocument/inlineCompletion` LSP requests. The chat backend already has a JSON-RPC loop; adding an LSP mode that responds to `inlineCompletion` by calling an OpenAI-compatible `/v1/completions` or `/v1/chat/completions` endpoint is architecturally clean.
- **Option B**: Leave completions on Copilot (which already works) and only swap chat. This is the smallest possible change.

## 4. Sign-In Removal

The sign-in surface is removed **indirectly** by the same changes above:

- `AssistantSignInDialog.java` renders a device-code flow dialog. It is triggered when the Posit AI language server reports `STATUS_NOT_SIGNED_IN`.
- The self-hosted backend never reports this status — it has no sign-in concept.
- By short-circuiting `chatCheckForUpdates` and `chatInstallUpdate`, the UI never offers to install the proprietary Posit Assistant, so the user never reaches a state where sign-in is requested.
- The `btnSignIn_` button still exists in `AssistantPreferencesPane`, but it only calls `assistant_.signIn(selectedType, ...)`. For the self-hosted backend, `assistantStatus` will return `STATUS_OK` immediately (or the backend won't be queried for sign-in state at all), so the button is never shown.

**No code removal is required** — the sign-in path simply becomes unreachable. If you want to be pedantic, you could remove `AssistantSignInDialog.java` and the `btnSignIn_` handler, but that's cosmetic.

## 5. Exact File List (Recommended Approach)

All changes are confined to the assistant/chat subsystem:

| File | Reason |
|------|--------|
| `src/node/ai-backend/` (new dir) | Self-hosted OpenAI-compatible backend |
| `src/cpp/session/CMakeLists.txt` | Install ai-backend into session resources |
| `src/cpp/session/modules/SessionChat.cpp` | Pass AI settings as env vars; short-circuit update/install; prefer bundled backend |
| `src/cpp/session/modules/chat/ChatInstallation.cpp` | Add bundled backend search path |
| `src/cpp/session/modules/chat/ChatConstants.hpp/cpp` | Add bundled path constant |
| `src/cpp/session/resources/schema/user-prefs-schema.json` | Add 6 AI configuration prefs |
| `src/cpp/session/modules/SessionUserPrefValues.R` | Regenerated accessors |
| `src/cpp/session/prefs/UserPrefValues.cpp` | Regenerated accessors |
| `src/cpp/session/include/session/prefs/UserPrefValues.hpp` | Regenerated accessors |
| `src/gwt/src/org/rstudio/studio/client/workbench/prefs/model/UserPrefsAccessor.java` | Regenerated accessors |
| `src/gwt/src/org/rstudio/studio/client/workbench/prefs/model/UserPrefsAccessorConstants*.java/properties` | Regenerated constants |
| `src/gwt/src/org/rstudio/studio/client/workbench/prefs/views/AssistantPreferencesPane.java` | Add OpenAI config UI |

If you also want to swap **inline completions**, add:
- `src/node/ai-backend/dist/server/main.js` — extend to handle LSP `textDocument/inlineCompletion`
- `src/cpp/session/modules/SessionAssistant.cpp` — add a new assistant type (e.g. `kAssistantOpenAi`) and route completions to the new backend

## 6. Separability Verification

| Concern | Status | Evidence |
|---------|--------|----------|
| Chat UI layout | **Independent** | Chat pane is a webview that loads `dist/client/index.html`. The backend serves it; content is identical regardless of provider. |
| Tools / context gathering | **Independent** | `SessionChat.cpp` exposes `runtime/getDetailedContext`, `runtime/executeCode`, etc. These are RPC methods RStudio implements. The backend calls them; it doesn't matter which LLM receives the context. |
| Chat participants | **Independent** | The protocol has no "participant" concept; the backend sends messages, RStudio renders them. |
| Inline completion UX | **Coupled to LSP** | The completion UX (ghost text, cycling, accept/dismiss) is driven by `SessionAssistant.cpp` and the LSP agent. Swapping the completion backend requires maintaining LSP compatibility. |

## 7. Open Risks / Unknowns

1. **License compliance**: The original Posit Assistant backend is proprietary. Replacing it with a self-hosted backend is fine for personal use, but distributing the modified RStudio may implicate the AGPL. This is a legal question, not a technical one.
2. **Protocol drift**: Posit may update `protocol.json` (currently v10.0) in future releases. The self-hosted backend must be updated to match. The fork pinned the protocol version.
3. **Copilot coexistence**: The changes above leave Copilot untouched. If a user selects Copilot for completions and the self-hosted backend for chat, both work independently. If you want the self-hosted backend to also handle completions, you need to decide whether it replaces Copilot or coexists.
4. **GWT regeneration**: Adding preferences requires running `scripts/generate-prefs.R`, which needs R. If the build environment doesn't have R, this is a blocker.
5. **CMake install path**: The bundled backend needs to land in a path that `locatePositAssistantInstallation()` finds. The fork used `src/cpp/session/CMakeLists.txt` to copy `ai-backend` into the session resources directory.
