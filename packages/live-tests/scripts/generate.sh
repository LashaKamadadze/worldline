#!/usr/bin/env bash
# Generates TypeScript client bindings for examples/todo-module into ./generated.
# `spacetime generate` builds the module locally; it does not need a running server.
set -euo pipefail
cd "$(dirname "$0")/.."
# Regenerate when either the example module or the library's server half changed.
sources=(../../examples/todo-module/src/index.ts ../localfirst/src/server/index.ts)
fresh=1
for src in "${sources[@]}"; do
  if [ ! -f generated/index.ts ] || [ "$src" -nt generated/index.ts ]; then fresh=0; fi
done
if [ "$fresh" = 1 ]; then
  exit 0
fi
spacetime generate --yes --lang typescript --out-dir generated --module-path ../../examples/todo-module
