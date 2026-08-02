#!/usr/bin/env bash
# Session start/end checks. Hooks are triggers; this script is the logic.
#
#   scripts/session.sh start [area]
#   scripts/session.sh end
#
# Block on correctness, warn on bookkeeping. A red gate or a stale graph blocks;
# unticked issues warn. Blocking has to stay rare enough to mean something.
set -uo pipefail
cd "$(git rev-parse --show-toplevel)"

BLOCKED=0
note()  { printf '  %s\n' "$*"; }
warn()  { printf '  warn: %s\n' "$*"; }
block() { printf '  BLOCK: %s\n' "$*"; BLOCKED=1; }

graph_state() {
  local g="graphify-out/graph.json" gm ht
  if [ ! -f "$g" ]; then
    note "knowledge graph: absent (generated, gitignored). Use ripgrep — not shell grep -r, which walks ui/dist/."
    return
  fi
  if stat -f %m "$g" >/dev/null 2>&1; then gm=$(stat -f %m "$g"); else gm=$(stat -c %Y "$g"); fi
  ht=$(git log -1 --format=%ct)
  if [ "$gm" -lt "$ht" ]; then
    warn "knowledge graph is stale — scripts/graph.sh will refuse. Rebuild (costs money) or use ripgrep."
  else
    note "knowledge graph: fresh. Run scripts/graph.sh query \"<question>\" before fanning out reads."
  fi
}

cmd_start() {
  local area="${1:-}"
  echo "== session start =="

  note "branch: $(git rev-parse --abbrev-ref HEAD)   HEAD: $(git log -1 --format=%h)"
  if [ "$(git rev-parse --abbrev-ref HEAD)" = "main" ]; then
    warn "you are on main — branch before changing anything (docs/principles/branches.md)."
  fi
  [ -n "$(git status --porcelain)" ] && warn "working tree is dirty at session start."

  graph_state

  if command -v gh >/dev/null 2>&1; then
    if [ -n "$area" ]; then
      echo
      note "open ideas in ${area} — read these before starting, so 'wrote it down once' does not become a graveyard:"
      gh issue list --label "$area" --label idea --state open \
        --json number,title --jq '.[] | "    #\(.number) \(.title)"' 2>/dev/null \
        || warn "could not reach GitHub."
    else
      echo
      note "no area given. Before starting in one, list its open ideas:"
      note "  scripts/session.sh start area:plugins"
    fi
  else
    warn "gh is not installed — the issue tracker is the work surface; without it you are blind to it."
  fi

  echo
  note "the contract is in CLAUDE.md. The rule that constrains you is in docs/principles/README.md."
}

cmd_end() {
  echo "== session end =="

  echo
  echo "-- gate --"
  if scripts/check.sh >/tmp/cubical-gate.log 2>&1; then
    note "scripts/check.sh green."
  else
    block "scripts/check.sh failed — tail of /tmp/cubical-gate.log:"
    tail -15 /tmp/cubical-gate.log | sed 's/^/      /'
  fi

  echo
  echo "-- generated artifacts --"
  local drift=0
  for g in gen_repo_layout gen_ipc_surface gen_ds_inventory gen_principles_readme; do
    python3 "scripts/$g.py" --check >/dev/null 2>&1 || { block "scripts/$g.py --check reports drift — regenerate and commit."; drift=1; }
  done
  [ "$drift" -eq 0 ] && note "all four reproduce byte-identically."

  echo
  echo "-- docs that should have moved with the code --"
  local base changed
  base=$(git merge-base HEAD origin/main 2>/dev/null || git merge-base HEAD main 2>/dev/null || echo "")
  if [ -n "$base" ]; then
    changed=$(git diff --name-only "$base"..HEAD)
    if echo "$changed" | grep -qE '^(crates|ui/src)/' && ! echo "$changed" | grep -qE '^docs/(implementation|architecture)/'; then
      warn "code changed but no doc under docs/implementation/ or docs/architecture/ did."
      warn "source carries no explanatory comments, so if this change needs explaining, that explanation currently exists nowhere."
    else
      note "code and owning docs moved together (or nothing under crates/ui changed)."
    fi

    if echo "$changed" | grep -qE '^(crates|ui/src)/' && ! echo "$changed" | grep -q '^CLAUDE.md$'; then
      warn "the Now block in CLAUDE.md is unchanged. Rewrite it at merge — never mid-session."
    fi
  else
    warn "no merge-base with main — skipping the diff-based checks."
  fi

  echo
  echo "-- issues --"
  if command -v gh >/dev/null 2>&1 && [ -n "$base" ]; then
    local refs
    refs=$(git log "$base"..HEAD --format='%s%n%b' | grep -oE '#[0-9]+' | sort -u | tr -d '#')
    if [ -n "$refs" ]; then
      for n in $refs; do
        local state
        state=$(gh issue view "$n" --json state --jq .state 2>/dev/null || echo "")
        [ "$state" = "OPEN" ] && warn "#$n is referenced by this branch and still open — close it or say why it stays open."
      done
    else
      warn "no issue referenced in any commit on this branch. Future work belongs in an issue, not in doc prose."
    fi
  fi

  echo
  if [ "$BLOCKED" -eq 1 ]; then
    echo "== BLOCKED: fix the items above before merging. =="
    return 1
  fi
  echo "== session end: nothing blocking. Warnings above are bookkeeping — read them, then decide. =="
  return 0
}

case "${1:-}" in
  start) shift; cmd_start "${1:-}" ;;
  end)   cmd_end ;;
  *) echo "usage: scripts/session.sh start [area:label] | end" >&2; exit 2 ;;
esac
