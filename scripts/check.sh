#!/usr/bin/env bash
# Run every project gate from one place. Usage: scripts/check.sh
# This script is the single source of truth for the gate set; CLAUDE.md points
# here. Keep the two in sync when a gate is added or removed.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

echo "==> cargo fmt";    cargo fmt --all --check
echo "==> cargo clippy"; cargo clippy --workspace --all-targets -- -D warnings
echo "==> cargo test";   cargo test --workspace
echo "==> tsc";          ( cd ui && npx tsc --noEmit )
echo "==> vitest";       ( cd ui && npx vitest run )
echo "==> build";        ( cd ui && npm run build )
echo "==> docs";         python3 scripts/check_docs.py
echo
echo "All gates green."
