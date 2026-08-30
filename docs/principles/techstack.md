# techstack — A new runtime dependency is a doc change first

**Rule:** Declare a new runtime dependency in the architecture stack section before installing it.

**Gate:** `scripts/gates/techstack.py` — it latches every manifest's runtime dependencies against the declared set in `scripts/techstack-declared.json`, target-specific Cargo dependency tables included, and separately requires every bare-specifier import in `ui/src` and `design-system/src` to name a package its own manifest declares. Two checks because each is blind where the other looks: the latch reads manifests, so an import declared nowhere and resolving on a transitive hoist was invisible to it; the import check reads sources, so a declared-but-unimported dependency is invisible to that.

**Why:** Dependencies are the easiest thing to add and among the hardest to remove; each one is a supply-chain surface, a bundle-size cost and a portability claim. Making the doc change first turns `npm install` from a reflex into a decision someone reviews. The stack is deliberate — Tauri + Rust, Solid, CodeMirror 6 + Lezer, Pretext, libSQL, Tantivy, Loro — and each entry has a stated reason.

**Exceptions:** Build-time tooling is not a runtime dependency: Node, npm and Vite are the toolchain and always have been, which is what "no Node runtime **in the shipped product**" means. Dev-only dependencies (e.g. `lucide-static`, a build-time icon source) likewise do not ship. A pin narrowing an existing dependency's features is a tightening, not an addition — `libsql` is pinned to `core` precisely to keep the remote/replication/TLS stack out.

**Detail:** [`../architecture/foundation.md`](../architecture/foundation.md) §2.
