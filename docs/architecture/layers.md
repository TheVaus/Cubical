> Locked decisions. Architecture review required to change. Index: [docs/architecture/README.md](README.md)

# Cubical — Layers

**Owner of layer status.** Which layers are closed, what each delivered, and
where its frozen spec is. Nothing else restates this — update it at layer close
and nowhere else.

## What a layer is, and what it is not

A layer is a **shippable increment**, and layers 0–5 are the ones that were
planned as a ladder. **v1.0 cuts at the end of Layer 5.**

Beyond L5 there is no ladder. Work that was once numbered L6–L10 now lives as
unscheduled GitHub issues labelled `idea`, carrying *what* and never *when* —
[plugins](https://github.com/TheVaus/Cubical/issues/61),
[sync](https://github.com/TheVaus/Cubical/issues/62),
[time machine](https://github.com/TheVaus/Cubical/issues/63),
[graph view](https://github.com/TheVaus/Cubical/issues/64),
[canvas](https://github.com/TheVaus/Cubical/issues/65),
[mobile](https://github.com/TheVaus/Cubical/issues/66).

That change is deliberate. A numbered ladder implies a commitment to order that
nobody had made, and an ordering written down is an ordering that gets designed
against. The one ordering argument worth keeping — that the plugin ABI is a
one-way door and wants a stable core beneath it — is recorded as a *note* on the
plugins issue, not as a position in a sequence.

## Status

| Layer | Status | Tag(s) (date) | Frozen spec |
|---|---|---|---|
| 0 — Bedrock | Closed | `l0` (05-13) | [`../archive/layers/layer-0-spec.md`](../archive/layers/layer-0-spec.md) |
| 1 — Document Model | Closed | `l1` (05-09) | [`../archive/layers/layer-1-spec.md`](../archive/layers/layer-1-spec.md) |
| 2 — Editing | Closed | `l2` (05-22) | [`../archive/layers/layer-2-spec.md`](../archive/layers/layer-2-spec.md) |
| 3 — Knowledge Graph | Closed | `l3` (06-01) | [`../archive/layers/layer-3-spec.md`](../archive/layers/layer-3-spec.md) |
| 4 — Search | Sub-layers merged; `l4` close-tag pending operator GUI smoke | `l4a` (06-03) · `l4a-fix`/`.1` (06-06) · `l4b`/`l4c`/`l4a-fix.2` (06-08) · `l4d` (06-15) | [`../archive/layers/layer-4-spec.md`](../archive/layers/layer-4-spec.md) |
| 5 — Daily-Driver Polish | In progress (the v1.0 cut) | — | [`../archive/work/specs/2026-06-25-layer-5-daily-driver-polish-design.md`](../archive/work/specs/2026-06-25-layer-5-daily-driver-polish-design.md) |

**Layer 5 has no `layer-5-spec.md`** and never did. Its design spec is the
record.

## What each layer delivered

- **0 — Bedrock.** Tauri scaffold, libSQL + migration runner, debounced file
  watcher, vault validation + scan-on-open, file-type registry, frontmatter
  I/O, atomic writes, typed Tauri command surface. **No UUID injection.**
- **1 — Document Model.** Canonical AST (`cubical-ast`), Lezer grammar,
  `get_canonical_ast` IPC, frontmatter → libSQL, the TS normalizer, and the
  cross-language parity harness that holds the two parsers in lockstep.
- **2 — Editing.** Writable editor with debounced autosave, Live Preview
  decorations, raw-source toggle, the Properties frontmatter editor, light and
  dark themes, vault-local settings, and the external-edit conflict policy with
  watcher feedback-loop suppression. *First demo-able milestone.*
- **3 — Knowledge Graph.** Wiki-link parsing and index, click-to-navigate,
  backlinks panel, nested tags and virtual tag pages, link and tag
  autocomplete, lazy block references, bounded embeds, unlinked mentions, and
  rename → the Pending Rewrites Cache.
- **4 — Search.** Tantivy full-text (BM25, stemming, typo tolerance),
  persistent results panel, `Cmd/Ctrl+K` Omni-Bar, and Dataview-style
  structured libSQL queries. The index lives under `.cubical/search/` with a
  schema-version stamp — a mismatch wipes and rebuilds — and never touches
  `.md`.
- **5 — Daily-Driver Polish.** In progress. The command/keymap registry and
  configurable shortcuts landed; the theme picker and Copy-as-Markdown have not
  started; the perf pass is open.

Work merged outside the ladder — tabs and multi-doc, the CLI, the embedded
terminal, the convergence layer, the design-system migration — is not a layer
and is not listed here. What exists in the tree right now is
[`../generated/repo-layout.md`](../generated/repo-layout.md) and
[`../generated/ipc-surface.md`](../generated/ipc-surface.md), which are
generated and cannot drift.

## Reading a frozen spec

A `layer-N-spec.md` is frozen at layer close and carries a banner saying so. It
preserves the *plan* and *what was built* as of that date. It is not current
truth — current truth is [`./`](README.md) and
[`../implementation/`](../implementation/). When something changes later, update
the architecture owner, never the frozen spec.
