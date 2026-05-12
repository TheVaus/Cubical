> Locked decisions. Architecture review required to change. Index: [docs/architecture/README.md](README.md)

# Cubical — Architecture: Constraints

## 13. What is explicitly out of scope

These are deliberate non-decisions. They are not "later" — they are "no."

- Centralized cloud database for core storage. The vault is local.
- Cross-vault asset deduplication or global asset folders.
- Proprietary file formats for content. Markdown only.
- Required user accounts.
- JavaScript plugin runtimes that bypass the WASM sandbox.
- Cross-app importers (Obsidian, Logseq, Notion, …). Community plugins can solve this; the core does not.
- Local AI / RAG / embeddings as a core feature. AI is a plugin-ecosystem concern; libSQL's vector capability is exposed to plugins that want it.
- Telemetry that ships content, file names, or vault structure off-device. (Crash reporting and aggregate usage stats may be opt-in, separately.)
