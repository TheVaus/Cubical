# Cubical — Product

> **Human-facing. Not agent-loaded.** This is the product narrative: what
> Cubical is, who it is for, and the vocabulary. It deliberately owns **no**
> technical fact — every one of those has an owner in
> [`docs/`](docs/README.md), and this file used to restate eight of them.
>
> If you are an agent, you want [`CLAUDE.md`](CLAUDE.md) and
> [`docs/principles/README.md`](docs/principles/README.md) instead.

## Summary

**Cubical is a blazing-fast, strictly local-first Personal Knowledge Management
app.** Point it at a folder of plain `.md` files — a *vault* — and get a fast
editor, a knowledge graph (links, backlinks, tags, embeds), and full-text plus
structured search.

The defining stance: **your Markdown files are the absolute source of truth.**
Search indexes, the link graph and caches are derived state that can be deleted
and rebuilt without losing a byte. No Electron, no Node.js runtime in the
shipped app, no required cloud account.

**Positioning:** Obsidian-class local Markdown PKM — but with performance,
sandboxing and no-lock-in treated as architectural non-negotiables rather than
features.

Desktop only for v1 (macOS, Windows, Linux).

## Problem & users

Cubical answers three predictable failures of knowledge tools:

1. **Lock-in** — proprietary formats and inaccessible cloud databases. Content
   is *only* plain Markdown; the vault works with the app uninstalled and the
   company gone.
2. **Sluggishness at scale** — performance is a feature, measured rather than
   asserted, with heavy work in Rust and off the UI thread.
3. **Fragility and broken trust** — tools that mangle files or lose external
   edits. Files survive being edited and renamed by other programs while the
   app is closed, and no app identifiers are written into `.md` files before
   sync onboarding.

**Target users:** power note-takers who own their data and think in Markdown,
wiki-links and tags — researchers, writers, engineers, students; local-first
believers who care about privacy, offline use and portability; eventually
developers extending Cubical through a sandboxed plugin ecosystem.

**Not v1:** mobile-first users, centralized-cloud teams, and users wanting
cross-app import baked into the core — that is left to plugins.

## Glossary

**Vault** — the user-chosen Markdown directory Cubical operates on.

**`.cubical/`** — the only Cubical-owned state inside a vault: durable config
plus a rebuildable cache.

**Canonical AST** — the single normalized syntax tree every non-editor system
consumes.

**Live Preview** — the default mode, where rendered Markdown and raw source
coexist. There is no separate read mode.

**Pending Rewrites Cache** — the deferred-write mechanism that makes renames
instant while coalescing the referrer file rewrites they imply.

**Block reference** — a `^block-id` on a paragraph, created lazily on first
reference.

**Omni-Bar** — the `Cmd/Ctrl+K` quick-nav and command palette.

**Dataview-style query** — a structured query over frontmatter.

**Lanes 1 / 2 / 3** — the three concurrency lanes: webview, Rust async, and
Web Worker plugins.

**Layer** — a shippable build increment. v1.0 cuts at the end of Layer 5.

**Core plugin** — a built-in toggleable feature block, the seed of the full
plugin ABI, gated by a `plugins.*` setting.

**`cubical_id`** — the per-file frontmatter UUID, minted only at sync
onboarding and never before.

---

## Where everything else went

This file once carried architecture, layer status, the roadmap, quality gates
and open debt. Each of those had an owner elsewhere and a second copy here, and
the copy drifted.

| You want | Read |
|---|---|
| The rules that constrain a change | [`docs/principles/README.md`](docs/principles/README.md) |
| Locked design decisions | [`docs/architecture/README.md`](docs/architecture/README.md) |
| Which layers closed, and what each delivered | [`docs/architecture/layers.md`](docs/architecture/layers.md) |
| What exists in the tree right now | [`docs/generated/`](docs/generated/) |
| What ships next, what is broken, what is merely an idea | GitHub Issues |
| What is explicitly out of scope | [`docs/architecture/constraints.md`](docs/architecture/constraints.md) |
