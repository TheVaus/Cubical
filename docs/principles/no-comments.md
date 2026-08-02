# no-comments — Source carries no explanatory comments

**Rule:** Write the explanation in the owning doc, not in the code.

**Gate:** none yet — planned `comments`. Baseline verified 0 violations, so it lands as a ratchet, not a cleanup.

**Why:** Rationale in source rots invisibly — nothing checks it, and a refactor leaves it describing code that no longer exists. Docs have owners and a link checker. This applies to doc-comments (`///`, `//!`, JSDoc) too: they are prose about code like any other comment. A brief one-liner is the ceiling — a pointer to the owning doc, a `TODO(...)`, or a section label in a long stylesheet.

**Exceptions:** Comment-shaped lines the toolchain *reads* are code, not prose, and must survive any sweep — `// @vitest-environment jsdom` (first line of DOM-touching tests) and `/// <reference types="vitest" />` (`ui/vite.config.ts`). Two pragma types across 52 files. Consequences of the rule, both deliberate: `#![warn(missing_docs)]` is not used, and clap help text is written as `#[arg(help = "…")]` data rather than doc comments.

**Detail:** [`../conventions.md`](../conventions.md) → Comments.
