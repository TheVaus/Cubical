# tauri-commands — Coarse-grained, verb-noun, typed both ways

**Rule:** Every command takes a typed request struct and returns a typed response struct.

**Gate:** none.

**Why:** Coarse commands keep the IPC surface small, which is the thing being allowlisted — a chatty fine-grained surface is a bigger attack surface and a slower one, since each call crosses the boundary. Typed structs on both sides mean a wire-shape change breaks the build rather than the running app. Verb-noun naming keeps the surface greppable as it grows.

**Exceptions:** none. Note that command *handlers* live in `cubical-engine` and `cubical-app` holds only thin shims — that split is what [`crate-separation.md`](crate-separation.md) protects, and it is why a new command is two small edits rather than one.

**Detail:** [`../conventions.md`](../conventions.md) → Tauri commands · [`../implementation/engine-ipc.md`](../implementation/engine-ipc.md).
