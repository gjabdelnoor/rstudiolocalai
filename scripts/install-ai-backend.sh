#!/usr/bin/env bash
#
# install-ai-backend.sh
#
# Installs the self-hosted, OpenAI-compatible AI backend (src/node/ai-backend)
# into the location RStudio already searches for the assistant backend:
#
#     ${XDG_DATA_HOME:-$HOME/.local/share}/pai/bin
#
# (see src/cpp/session/modules/chat/ChatInstallation.cpp). After running this,
# open the AI pane in RStudio -- no Posit account or sign-in is required. Set
# the provider details in Tools > Global Options > AI (or the AI pane's
# settings button).
#
# Alternatively, skip installation entirely and point RStudio at the source
# tree directly:
#
#     export RSTUDIO_POSIT_AI_PATH="$(git rev-parse --show-toplevel)/src/node/ai-backend"
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
# Copy the files RStudio's installation check requires plus the runtime tree.
cp -R "${SRC}/dist" "${DEST}/"
cp "${SRC}/package.json" "${SRC}/protocol.json" "${DEST}/"

echo "Done. Restart RStudio (or reopen the AI pane) to use the new backend."
