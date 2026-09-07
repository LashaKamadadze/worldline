#!/usr/bin/env bash
# Installs workspace links, generates bindings, and runs the live tests.
# Usage: scripts/test.sh [vitest args...]   (run inside `nix develop`)
set -euo pipefail
cd "$(dirname "$0")/../../.."
pnpm install --silent
cd packages/live-tests
./scripts/generate.sh
exec pnpm exec vitest run "$@"
