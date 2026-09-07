set shell := ["bash", "-uc"]

default:
    @just --list

# Install workspace dependencies
install:
    pnpm install

# Typecheck every package
typecheck:
    pnpm -r typecheck

# Unit, end-to-end (fake server) and a short deterministic simulation
test:
    pnpm --filter stdb-localfirst test

# Long deterministic simulation run (override with DST_SEEDS / DST_STEPS)
dst seeds="500" steps="200":
    DST_SEEDS={{seeds}} DST_STEPS={{steps}} pnpm --filter stdb-localfirst exec vitest run test/dst.test.ts

# Start a local SpacetimeDB (foreground)
server:
    spacetime start --data-dir .stdb-data --non-interactive

# Publish the example module to the local server and regenerate client bindings
publish:
    spacetime publish -s local -y --delete-data=always todo-lf --module-path examples/todo-module
    spacetime generate -y --lang typescript --out-dir examples/todo-client/src/module_bindings --module-path examples/todo-module

# Run the Node demo against the local server (needs `just server` and `just publish`)
demo:
    pnpm --filter todo-client demo

# Full integration: publish + demo (server must be running)
integration: publish demo

# Headless-browser tests (Playwright from nixpkgs): OPFS adapter + full sync in Chromium/Firefox/WebKit
browser-test:
    pnpm --filter browser-tests test
