#!/usr/bin/env bash
# The gate set. Usage: scripts/check.sh — see docs/conventions.md (gate order is load-bearing).
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

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
