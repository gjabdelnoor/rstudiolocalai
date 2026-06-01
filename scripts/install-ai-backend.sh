#!/usr/bin/env bash
#
# install-ai-backend.sh
#
# Installs the RStudio AI backend (src/node/ai-backend) into the location
# RStudio already searches for the assistant backend:
#
#     ${XDG_DATA_HOME:-$HOME/.local/share}/pai/bin
#
# (see src/cpp/session/modules/chat/ChatInstallation.cpp). After running this,
# open the AI pane in RStudio -- no Posit account or sign-in is required. Set
# the LLM details in the AI pane's settings (or via the env vars listed in
# the backend README).
#
# The backend hosts a Pi coding agent session in-process, so the install step
# also runs `npm install --ignore-scripts` to fetch Pi Agent and its runtime
# dependencies. (We pass --ignore-scripts because Pi Agent's package scripts
# invoke a Bun-based bundler that isn't needed for our use case -- the
# published package already contains a pre-built dist/ tree.)
#
# Alternatively, skip installation entirely and point RStudio at the source
# tree directly:
#
#     export RSTUDIO_AI_CHAT_PATH="$(git rev-parse --show-toplevel)/src/node/ai-backend"
#
# Usage:
#     scripts/install-ai-backend.sh            # install to the user data dir
#     DEST=/custom/path scripts/install-ai-backend.sh
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="${SCRIPT_DIR}/../src/node/ai-backend"
DEST="${DEST:-${XDG_DATA_HOME:-$HOME/.local/share}/pai/bin}"

if [ ! -f "${SRC}/dist/server/main.js" ]; then
   echo "error: backend source not found at ${SRC}" >&2
   exit 1
fi

echo "Installing RStudio AI backend"
echo "  from: ${SRC}"
echo "  to:   ${DEST}"

mkdir -p "${DEST}"

# Copy the static files RStudio's installation check requires.
cp -R "${SRC}/dist" "${DEST}/"
cp "${SRC}/package.json" "${SRC}/protocol.json" "${DEST}/"

# Install Pi Agent and its runtime dependencies via npm. We use a temp dir
# to run the install, then copy node_modules over. This avoids polluting
# the source tree and keeps the destination self-contained.
TMPDIR="$(mktemp -d)"
trap 'rm -rf "${TMPDIR}"' EXIT
cp "${SRC}/package.json" "${TMPDIR}/"
cp "${SRC}/package-lock.json" "${TMPDIR}/" 2>/dev/null || true

echo "Fetching Pi Agent runtime via npm install --ignore-scripts (this can take a minute)..."
(
   cd "${TMPDIR}"
   if command -v npm >/dev/null 2>&1; then
      npm install --ignore-scripts --no-audit --no-fund --omit=dev
   else
      echo "error: npm not found in PATH. Install Node.js >=18 (https://nodejs.org) and retry." >&2
      exit 1
   fi
)

# Copy node_modules + lockfile to the destination.
cp -R "${TMPDIR}/node_modules" "${DEST}/"
[ -f "${TMPDIR}/package-lock.json" ] && cp "${TMPDIR}/package-lock.json" "${DEST}/"

echo "Done."
echo
echo "Next steps:"
echo "  1. Set your LLM provider's API key in the environment, e.g.:"
echo "       export ANTHROPIC_API_KEY=sk-ant-..."
echo "     (Pi Agent also supports OPENAI_API_KEY, GOOGLE_API_KEY, OLLAMA_HOST, etc.)"
echo "  2. Optional: tune Pi Agent in Tools > Global Options > AI."
echo "  3. Restart RStudio (or reopen the AI pane) to load the new backend."
