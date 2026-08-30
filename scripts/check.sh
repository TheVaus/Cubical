#!/usr/bin/env bash
# The gate set. Usage: scripts/check.sh — gate order is load-bearing (see below).
#
# ORDER, and why:
#
#  1. Static gates first. They are seconds-fast, need no build, and are the ones
#     most likely to be the actual reason a change is wrong. Putting them last
#     meant a slow or flaky cargo step could abort the script before they ever
#     ran — `set -e` stops at the first failure, so a gate that never runs looks
#     exactly like a gate that passed. See issue #52.
#  2. Frontend gates next: Tauri's generate_context!() embeds ui/dist at compile
#     time, so the bundle must exist before any cargo step builds cubical-app.
#  3. Cargo last, slowest, and the only stage that can currently abort early.
#
# EXIT CODES: `scripts/check.sh | tail` reports tail's status, not the gate's.
# Capture the real one — run it bare, or `scripts/check.sh > log 2>&1; echo $?`.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

echo "==> comments";            python3 scripts/gates/comments.py
echo "==> generated";           python3 scripts/gates/generated.py
echo "==> ds-components";       python3 scripts/gates/ds_components.py
echo "==> ds-colours";          python3 scripts/gates/ds_colours.py
echo "==> composition";        python3 scripts/gates/composition.py
echo "==> dependency-boundary"; python3 scripts/gates/dependency_boundary.py
echo "==> techstack";           python3 scripts/gates/techstack.py
echo "==> symbol-anchors";      python3 scripts/gates/symbol_anchors.py
echo "==> docs";                python3 scripts/check_docs.py

echo "==> tsc";          ( cd ui && npx tsc --noEmit )
echo "==> tsc (design-system)"; ( cd design-system && npx tsc --noEmit )
echo "==> vitest";       ( cd ui && npx vitest run )
echo "==> build";        ( cd ui && npm run build )

echo "==> cargo fmt";    cargo fmt --all --check
echo "==> cargo clippy"; cargo clippy --workspace --all-targets -- -D warnings
echo "==> cargo test";   cargo test --workspace
echo "==> perf";         python3 scripts/gates/perf.py   # opt-in: CUBICAL_PERF=1
echo
echo "All gates green."
