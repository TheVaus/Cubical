> **Frozen — historical record.** This file is preserved as written and is not maintained. It records what was believed, planned or built at the time; it is **not** current truth. Current truth lives in [`docs/architecture/`](../../../architecture/) and [`docs/implementation/`](../../../implementation/). Do not edit to "correct" it — a corrected record is no longer a record.

L3 Session E — Virtual tag pages

Refs: docs/build-order.md §3, docs/layer-3-spec.md §2.5 + §3.1 + §8 Session E.

Scope: a `tag:` route that opens a virtual page (libSQL-backed, no
backing `.md` file) listing every file carrying that tag or any of its
descendants (prefix match — `tag:parent` matches `parent`,
`parent/child`, deeper). Reached by clicking a tag decoration in the
editor or a tag chip in Properties. Empty state when unused. File rows
navigate via the existing `handleSelectFile` seam.

Pre-work: Session D shipped clean (228 Rust + 233 vitest), origin/main
is current. No outstanding fixes — the Session C backlinks self-trigger
bug (`untrack` fix in `ui/src/sidebar/Backlinks.tsx`) landed in the
Session D branch and is verified.

Out of scope this session: link/tag autocomplete (F), block refs (G).
Just the `tag:` route + listing + navigation in / out.

Smoke: extend `~/Developer/sandbox/tag-test/` (Inbox.md + Project.md
already share `#project/cubical/*` — perfect prefix-match smoke) for
`cargo tauri dev` verification at session end.

Start by reading docs/layer-3-spec.md §2.5 and §3.1 (`query_tag_page`
IPC shape: `{ vault_id, tag_path } → { files: [{ path, title }] }`).
The Session C backlinks IPC + sidebar shell (`crates/cubical-app/src/
commands/backlinks.rs`, `ui/src/sidebar/Backlinks.tsx`) is the closest
existing shape — a libSQL-backed listing IPC with a Solid panel — so
mirror its skeleton for the query handler. For the route, look at how
`App.tsx` currently dispatches between the editor pane and other views
(there is none yet — this session introduces the first non-file view,
so the route mechanism is the load-bearing design call).
