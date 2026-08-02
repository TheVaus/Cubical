# techstack — A new runtime dependency is a doc change first

**Rule:** Declare a new runtime dependency in the architecture stack section before installing it.

**Gate:** none yet — planned `techstack`.

**Why:** Dependencies are the easiest thing to add and among the hardest to remove; each one is a supply-chain surface, a bundle-size cost and a portability claim. Making the doc change first turns `npm install` from a reflex into a decision someone reviews. The stack is deliberate — Tauri + Rust, Solid, CodeMirror 6 + Lezer, Pretext, libSQL, Tantivy, Loro — and each entry has a stated reason.

**Exceptions:** Build-time tooling is not a runtime dependency: Node, npm and Vite are the toolchain and always have been, which is what "no Node runtime **in the shipped product**" means. Dev-only dependencies (e.g. `lucide-static`, a build-time icon source) likewise do not ship. A pin narrowing an existing dependency's features is a tightening, not an addition — `libsql` is pinned to `core` precisely to keep the remote/replication/TLS stack out.

**Detail:** [`../architecture/foundation.md`](../architecture/foundation.md) §2.
