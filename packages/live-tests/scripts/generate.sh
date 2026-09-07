#!/usr/bin/env bash
# Generates TypeScript client bindings for examples/todo-module into ./generated.
# `spacetime generate` builds the module locally; it does not need a running server.
set -euo pipefail
cd "$(dirname "$0")/.."
if [ -f generated/index.ts ] && [ generated/index.ts -nt ../../examples/todo-module/src/index.ts ]; then
  exit 0
fi
spacetime generate --yes --lang typescript --out-dir generated --module-path ../../examples/todo-module
