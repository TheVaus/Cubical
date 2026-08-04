#!/usr/bin/env bash
# graphify wrapper that refuses a stale graph. Usage: scripts/graph.sh query "<question>" | path "A" "B" | explain "<node>"
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

GRAPH="graphify-out/graph.json"

if ! command -v graphify >/dev/null 2>&1; then
  echo "graph.sh: graphify is not installed on this machine." >&2
  echo "  It is a user-local tool, not vendored: ~/.claude/skills/graphify/SKILL.md" >&2
  echo "  Fall back to ripgrep for this session." >&2
  exit 127
fi

if [ ! -f "$GRAPH" ]; then
  echo "graph.sh: no $GRAPH in this checkout (it is generated and gitignored)." >&2
  echo "  Build it with: graphify . --update   — this costs money, see graphify-out/cost.json" >&2
  echo "  Fall back to ripgrep if you do not want to pay for a build." >&2
  exit 1
fi

if ! python3 scripts/graph_freshness.py; then
  echo "  (checked by scripts/graph_freshness.py — content, not timestamps)" >&2
  if [ "${GRAPH_STALE_OK:-}" != "1" ]; then
    exit 1
  fi
  echo "  GRAPH_STALE_OK=1 set — proceeding against a stale graph. Verify every hit against the files." >&2
fi

exec graphify "$@"
