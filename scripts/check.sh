#!/usr/bin/env bash
# The gate set. Usage: scripts/check.sh — gate order is load-bearing (see below).
#
# Frontend gates run FIRST: Tauri's generate_context!() embeds ui/dist at compile
# time, so the bundle must exist before any cargo step that builds cubical-app.
#
# EXIT CODES: `scripts/check.sh | tail` reports tail's status, not the gate's.
# Capture the real one — run it bare, or `scripts/check.sh > log 2>&1; echo $?`.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

echo "==> tsc";          ( cd ui && npx tsc --noEmit )
echo "==> tsc (design-system)"; ( cd design-system && npx tsc --noEmit )
echo "==> vitest";       ( cd ui && npx vitest run )
echo "==> build";        ( cd ui && npm run build )
echo "==> cargo fmt";    cargo fmt --all --check
echo "==> cargo clippy"; cargo clippy --workspace --all-targets -- -D warnings
echo "==> cargo test";   cargo test --workspace
echo "==> comments";            python3 scripts/gates/comments.py
echo "==> generated";           python3 scripts/gates/generated.py
echo "==> ds-components";       python3 scripts/gates/ds_components.py
echo "==> dependency-boundary"; python3 scripts/gates/dependency_boundary.py
echo "==> techstack";           python3 scripts/gates/techstack.py
echo "==> symbol-anchors";      python3 scripts/gates/symbol_anchors.py
echo "==> perf";                python3 scripts/gates/perf.py
echo "==> docs";                python3 scripts/check_docs.py
echo
echo "All gates green."
