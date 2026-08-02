#!/usr/bin/env bash
# Point git at the tracked hooks. Run once per clone:  scripts/hooks/install.sh
#
# core.hooksPath rather than copying into .git/hooks, so the hooks stay tracked
# and a change to them reaches everyone instead of one person's checkout.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

chmod +x scripts/hooks/pre-commit scripts/hooks/pre-push
git config core.hooksPath scripts/hooks
echo "core.hooksPath -> scripts/hooks"
echo "  pre-commit: formatting only"
echo "  pre-push:   generated-doc drift (blocks), graph staleness (warns)"
echo "  the full gate is scripts/check.sh, run by CI on every PR and push to main"
