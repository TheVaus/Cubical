#!/usr/bin/env bash
# Run every project gate from one place. Usage: scripts/check.sh
# This script is the single source of truth for the gate set; CLAUDE.md points
# here. Keep the two in sync when a gate is added or removed.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

# Frontend gates run first: the Tauri `generate_context!()` macro embeds
# `ui/dist` at compile time (frontendDist in tauri.conf.json), so the bundle
# must exist before any cargo step that builds `cubical-app`. Building it here
# keeps the gate correct from a clean checkout (e.g. CI), not just when a stale
# `ui/dist` happens to be lying around.
echo "==> tsc";          ( cd ui && npx tsc --noEmit )
echo "==> tsc (design-system)"; ( cd design-system && npx tsc --noEmit )
echo "==> vitest";       ( cd ui && npx vitest run )
echo "==> build";        ( cd ui && npm run build )
echo "==> cargo fmt";    cargo fmt --all --check
echo "==> cargo clippy"; cargo clippy --workspace --all-targets -- -D warnings
echo "==> cargo test";   cargo test --workspace
echo "==> docs";         python3 scripts/check_docs.py
echo
echo "All gates green."
