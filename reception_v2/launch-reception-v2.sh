#!/bin/sh
set -eu
ROOT_DIR=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
cd "$ROOT_DIR"

NODE_BIN=${NODE_BIN:-$(command -v node || true)}
if [ -z "$NODE_BIN" ] || [ ! -x "$NODE_BIN" ]; then
  printf '%s\n' 'Node 24+ is required. Set NODE_BIN=/absolute/path/to/node.' >&2
  exit 78
fi

if [ -z "${XHS_PLAYWRIGHT_MODULE:-}" ]; then
  for candidate in \
    "$ROOT_DIR/node_modules/playwright/index.js" \
    "$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.js"
  do
    if [ -f "$candidate" ]; then
      XHS_PLAYWRIGHT_MODULE=$candidate
      break
    fi
  done
fi
if [ -z "${XHS_PLAYWRIGHT_MODULE:-}" ] || [ ! -f "$XHS_PLAYWRIGHT_MODULE" ]; then
  printf '%s\n' 'Playwright is missing. Set XHS_PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.js.' >&2
  exit 78
fi

export XHS_PLAYWRIGHT_MODULE
exec "$NODE_BIN" reception_v2/main.mjs run --arm "$@"
