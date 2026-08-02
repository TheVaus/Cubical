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

if stat -f %m "$GRAPH" >/dev/null 2>&1; then
  graph_mtime=$(stat -f %m "$GRAPH")
else
  graph_mtime=$(stat -c %Y "$GRAPH")
fi
head_time=$(git log -1 --format=%ct)

if [ "$graph_mtime" -lt "$head_time" ]; then
  hours=$(((head_time - graph_mtime) / 3600))
  echo "graph.sh: REFUSING — the graph is ${hours}h older than HEAD." >&2
  echo "  A stale graph reports deleted code as live, confidently and without warning." >&2
  echo "  Rebuild:  graphify . --update   (costs money, see graphify-out/cost.json)" >&2
  echo "  Override: GRAPH_STALE_OK=1 scripts/graph.sh $*" >&2
  if [ "${GRAPH_STALE_OK:-}" != "1" ]; then
    exit 1
  fi
  echo "  GRAPH_STALE_OK=1 set — proceeding against a stale graph. Verify every hit against the files." >&2
fi

exec graphify "$@"
