# tests — `scripts/check.sh` is the whole definition of green

**Rule:** Run the script, not the pieces, before claiming anything passes.

**Gate:** `scripts/check.sh` — CI runs the same script on every PR and every push to `main`.

**Why:** One definition of green means adding or removing a gate is a one-line change that CI follows automatically, with no duplicated list in the workflow to drift. **Gate order is load-bearing**: frontend gates run first because Tauri's `generate_context!()` embeds `ui/dist` at compile time, so the bundle must exist before any cargo step builds `cubical-app`. Running pieces individually is how you get a green local run and a red CI one. Counts are a query, never a recorded fact — a written count is stale within days.

**Exceptions:** One known flake — `cubical-core`'s `watcher::…dropping_handle_stops_event_delivery_within_100ms` fails under full-workspace load and passes in isolation. Because `set -e` aborts the script there, the crates after it do not run; re-run them explicitly before claiming green. A gate reaching into a new workspace directory also needs a matching `npm ci` in CI — omitting one silently killed every downstream gate for twelve days.

**Detail:** `scripts/check.sh` is the list; `.github/workflows/ci.yml` runs it. Unit tests live in `cubical-core`, `cubical-ast` and `cubical-index`; the app crate has integration tests against a temp vault; the frontend has vitest coverage.
