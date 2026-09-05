# tests — `scripts/check.sh` is the whole definition of green

**Rule:** Run the script, not the pieces, before claiming anything passes.

**Gate:** `scripts/check.sh` — CI runs the same script on every PR and every push to `main`.

**Why:** One definition of green means adding or removing a gate is a one-line change that CI follows automatically, with no duplicated list in the workflow to drift. **Gate order is load-bearing**: the static gates run first because `set -e` stops at the first failure, so a slow or flaky cargo step that aborts the script makes a gate that never ran look exactly like one that passed. Running pieces individually is how you get a green local run and a red CI one. Counts are a query, never a recorded fact — a written count is stale within days.

**Exceptions:** None — there is no known flaky test, and a red gate means a real failure. There used to be one: a watcher test asserted wall-clock latency across an `await` and so measured the machine rather than the code, failing under load. It was fixed rather than tolerated, because a standing "expected red" trains everyone to skim past the gate. `set -e` still aborts at the first failure, so a run that stopped partway leaves every later stage **unknown** rather than passing — a complete run ends with `All gates green.` A gate reaching into a new workspace directory also needs a matching `npm ci` in CI — omitting one silently killed every downstream gate for twelve days.

**Detail:** `scripts/check.sh` is the list; `.github/workflows/ci.yml` runs it. Unit tests live in `cubical-core`, `cubical-ast` and `cubical-index`; the app crate has integration tests against a temp vault; the frontend has vitest coverage.
