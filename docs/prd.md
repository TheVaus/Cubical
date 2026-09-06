# Cubical — Product Requirements

> **Contributor-facing.** What the product is, what it currently guarantees,
> what has to be true to call v1.0 done, and where it does not yet keep its own
> promises. For the short human-facing narrative see [`../prd.md`](../prd.md);
> for the rules that constrain a change see
> [`principles/README.md`](principles/README.md).

## 1. What this document is

This is the single read for someone who needs to know what Cubical is supposed
to do before changing it. It sits outside the four documentation tiers described
in [`README.md`](README.md) — it is not a principle, not a locked architectural
decision, not an implementation rationale, and not generated.

**It deliberately restates facts owned elsewhere.** Every other doc in this tree
follows [`single-owner-facts`](principles/single-owner-facts.md); a PRD that
linked for every fact would be a table of contents. The trade is explicit: this
file is a known drift surface, and where it disagrees with an owner, **the owner
is right**.

Four facts are *not* restated here, because `scripts/check_docs.py` enforces
their single owner and because all four move:

| Fact | Owner |
|---|---|
| The measured performance ceilings and medians | [`architecture/foundation.md`](architecture/foundation.md) §1 |
| Which layers are closed and what each delivered | [`architecture/layers.md`](architecture/layers.md) |
| Which platforms ship and what each promises | [`architecture/distribution.md`](architecture/distribution.md) |
| The index schema | [`architecture/document-model.md`](architecture/document-model.md) |

The vocabulary — vault, canonical AST, Live Preview, Pending Rewrites Cache,
Omni-Bar, block reference, layer — is defined once in
[`../prd.md`](../prd.md) and is not redefined here.

## 2. The product

Cubical is a local-first personal knowledge management app. It opens a directory
of plain `.md` files — a vault — and provides an editor, a knowledge graph of
links, backlinks, tags and embeds, and full-text plus structured search.

**The defining stance is that the Markdown files are the source of truth and
everything else is derived.** Indexes, caches, the search corpus and the graph
can all be deleted; reopening the vault rebuilds them. This is what makes the
vault portable, the app crash-safe, and lock-in structurally impossible rather
than merely promised.

**Who it is for:** people who already think in Markdown, wiki-links and tags and
who intend to own their files — researchers, writers, engineers, students — plus
local-first users who care about privacy, offline use and portability. Later,
developers extending Cubical through a sandboxed plugin ABI.

**Who it is not for, in v1:** mobile-first users, teams wanting a shared cloud
workspace, and anyone expecting one-click import from another PKM tool. The
first is deferred, the second is refused, the third is delegated to plugins.

**Positioning:** Obsidian-class local Markdown PKM, with performance,
sandboxing and no-lock-in treated as architectural non-negotiables rather than
as features that can be traded away under schedule pressure.

## 3. Product principles

Six promises carry the product. Each is owned by a file that states it in full;
the line here is what it means for a *user*.

- **Markdown is truth; derived state is disposable.** Delete the index and lose
  nothing but time. — [`derived-state-disposable`](principles/derived-state-disposable.md),
  [`architecture/vault.md`](architecture/vault.md) §3
- **Converge, don't intercept.** Edit, move or delete files with any other tool
  at any time; Cubical catches up rather than fighting you. Where it cannot
  recover the semantics it says so — silent rot is the one unacceptable
  outcome. — [`convergence-over-interception`](principles/convergence-over-interception.md)
- **Performance is measured, not asserted.** Speed claims are wall-clock medians
  over deterministic fixtures, and the bars ratchet down, never
  up. — [`performance`](principles/performance.md)
- **Extension is sandboxed.** Third-party code runs in a WASM sandbox with
  granular, explicit capability grants. A feature that hands native capability
  to external code is a *gateway* and must be opt-in, non-corrupting and
  auditable. — [`native-capability-gateway`](principles/native-capability-gateway.md)
- **The vault is portable and self-contained.** No external service is required
  to open it, and nothing Cubical owns lives outside `.cubical/` and
  `.assets/`. — [`architecture/vault.md`](architecture/vault.md)
- **Features are composable blocks over an always-on substrate.** Switching a
  feature off changes behaviour and derived state only, and leaves the `.md`
  byte-identical. — [`composability`](principles/composability.md)

Two supporting rules are invisible to users but shape everything: only
`cubical-app` may depend on Tauri ([`crate-separation`](principles/crate-separation.md)),
which is what makes a second frontend possible at all; and the webview never
gets shell or broad filesystem access
([`backend-frontend-boundary`](principles/backend-frontend-boundary.md)).

## 4. Capabilities

Each area states what it does, what it guarantees, and what is deliberately not
built. "Not built" here means *absent by decision or by schedule* — genuine
defects are in §9.

### Vault and file safety

**Does.** Opens and validates a user-chosen directory, scans it into an index,
and watches it for changes. Creates files and folders. Writes atomically.
Vault-local settings live in `.cubical/config.toml`; machine-local session state
lives in the index. One vault per window, multiple windows allowed.

**Guarantees.** `.cubical/` is the only state Cubical owns inside the vault, and
splits cleanly into durable config (`config.toml`, `themes/`) and rebuildable
cache (everything else). No app identifier is written into any `.md` file — path
is the only identity until sync onboarding. External edits made while the app is
closed are handled: an external rename is *adopted*, running the same rename
transaction so referrer links follow. When an open buffer has unsaved edits and
the file changes underneath, the prior buffer is written to `.cubical/recovery/`
and a three-way merge is offered — the user's work is never silently
overwritten. A malformed note is logged and skipped, and heals on the next scan
without special recovery. A second process cannot become a concurrent writer: a
cross-process OS lock is taken on open, and the kernel releases it if the owner
dies.

**Not built.** Cross-filesystem folder moves. Folder-rename adoption. Encryption
at rest. A backup or corruption-recovery tool beyond rebuild-from-`.md`.

### Editor and Live Preview

**Does.** A CodeMirror 6 editor with debounced autosave, tabs, and a Properties
panel for editing frontmatter. Live Preview is the *only* normal mode — the line
under the cursor shows raw Markdown, every other line shows rendered form. A Raw
Source toggle exists for power users. There is no separate read mode.

**Guarantees.** Frontmatter is edited in place, so foreign comments and blank
lines survive an edit to an unrelated key; a naive re-emit would reformat the
user's file, which the source-of-truth rule forbids. A rejected or lossy
property edit warns and preserves the original rather than coercing silently.
Fenced blocks render from a registry keyed on the info string.

**Not built.** Inline `$…$` math (display `$$…$$` occupies whole lines only).
Syntax highlighting inside fenced code. Callouts, footnotes, Mermaid,
interactive checkboxes, templates, daily notes, split panes, an outline panel,
RTL. Each is a filed idea, not an oversight.

### Document model

**Does.** Parses Markdown into a canonical AST defined in `cubical-ast`, with no
Tauri or webview dependency, and mirrors it in TypeScript. A cross-language
parity harness holds the two parsers in lockstep.

**Guarantees.** One document interpretation across the whole system. Anything
that indexes, exports, or will cross the plugin boundary consumes the canonical
AST; only the editor's own rendering may read the Lezer tree directly.
Frontmatter parsing is total — malformed YAML yields "no frontmatter", never an
error.

**Not built.** The AST is deliberately slim: no nodes for tables, footnotes,
definition lists, math or callouts. AST-bearing syntax pays a two-parser cost; a
decoration over an existing node does not. Cross-app importers being out of
scope is what makes the slimness affordable.

### Knowledge graph

**Does.** Wiki-links in both body and frontmatter string values, with
click-to-navigate, a backlinks panel and unlinked mentions. Inline and
frontmatter tags with `/` nesting and auto-generated virtual tag pages. Block
references assigned lazily on first use. Bounded embeds, including non-Markdown
targets served as bytes through the same viewer path their own tab uses. Renames
propagate through the Pending Rewrites Cache.

**Guarantees.** A link written as a property value earns a backlink and is
rewritten by a rename like any other. Link resolution is exact path, then unique
case-insensitive basename, then unique suffix; ambiguity resolves to nothing and
the row is still stored, so unresolved links surface in the UI and a later rename
can re-resolve them. Renames are instant and the referrer rewrites are coalesced
and deferred; reads materialize pending rewrites, the status bar always shows the
unflushed count, and undo is instant inside that window. The queue is the one
piece of non-re-derivable state, so it is journalled to `.cubical/renames.jsonl`.
Where a rename pairing is ambiguous the engine **refuses to pair** and sends the
residue to the Integrity panel — a missed rename is recoverable, a wrong rewrite
corrupts Markdown. There is deliberately no repair-all.

**Not built.** Folder-rename adoption. Auto-fix for ambiguous pairings.

### Search and structured query

**Does.** Tantivy full-text search with BM25, stemming, typo tolerance,
field-scoped queries and search-as-you-type prefix matching, in a persistent
results panel and the `Cmd/Ctrl+K` Omni-Bar. Dataview-style `LIST`/`TABLE`/`COUNT`
queries with `FROM`/`WHERE`/`SORT` over notes and over `.csv`, `.tsv`, `.xlsx`
and `.xlsm` files.

**Guarantees.** The index lives only under `.cubical/search/` with a
schema-version stamp; a mismatch wipes and rebuilds, and it never writes to
`.md`. While indexing, search returns current results flagged as still-indexing
rather than an error. Every literal and key in a user-authored query is a bound
parameter, which is what makes a query block unable to inject SQL. Query
semantics are stated rather than emergent: comparison follows the literal's type,
a missing value matches no comparison including `!=`, and sorts put missing last
in both directions.

**Not built.** Per-occurrence results — a search hit opens the file, not the
match; there is no jump-to-hit. Cross-vault search. Local AI, RAG or embeddings,
which are refused as a core feature.

### Navigation and shell

**Does.** A left panel with a virtualized file explorer and search, a central
tabbed workspace, a right sidebar of backlinks and unlinked mentions, and a
status bar carrying indexer progress, vault health and the pending-rewrites
count. A command and keymap registry backs both the app-level key handling and
the editor keymap, and shortcuts are rebindable from Settings.

**Guarantees.** Tab identity is derived from the view, never minted, so every
document navigation is open-or-focus: nothing replaces a tab's content and
nothing opens a second tab on the same document. Only rebindings are persisted,
per vault, as a diff. Modifier-clicks are deliberately not a navigation channel,
so Mod-click and Shift-click keep their text-selection meaning. Non-Markdown
files occupy ordinary file tabs and so inherit persistence, rename remapping and
history for free.

**Not built.** Preview or pinned tabs, "open in new tab", middle-click, split
panes, reveal-in-tree, bookmarks. Navigation history is global rather than
per-tab and is not persisted across sessions.

### Graph view

**Does.** A WebGPU-rendered knowledge graph with Rust-side force-directed layout.

**Guarantees.** Layout runs in Rust against a measured bar
([`architecture/foundation.md`](architecture/foundation.md) §1), which is why it
is not a GPU compute pass.

**Not built.** The engine-side graph filter is not reachable from the UI.

### CLI and embedded terminal

**Does.** A `cubical` terminal frontend, and an embedded PTY terminal inside the
app. Both reach the engine through the same wire boundary as the GUI.

**Guarantees.** `cubical-ipc` owns the wire in both directions, so every frontend
parses and prints identically. Rust owns the PTY and the child process; the
webview receives an opaque byte stream and sends keystrokes, and never gains
shell or filesystem access. The terminal is default-off, and disabling it
force-closes every terminal tab and reaps the sessions. Socket auth is filesystem
permissions only.

**Not built.** The socket transport is Unix-domain only, so CLI attach on
Windows is a stub.

### Design system and theming

**Does.** Every control the app renders comes from `design-system/` through the
`@ds` alias, spending one canonical token surface. Light and dark themes, with
the editor's own chrome theme generated from the same computed tokens. User
themes are plain CSS files under `.cubical/themes/`.

**Guarantees.** No hardcoded colours, fonts or spacings outside the token
surface, enforced by a gate rather than by review; the baseline is zero raw
controls in the app. A user-installed theme re-themes the editor chrome with no
editor-code change. Components are self-contained and may not lean on the
playground's global stylesheets. The design system is extended additively — never
forked or worked around app-side.

**Not built.** A theme picker in Settings. CSS snippets, which would freeze the
design-system contract.

### Extensibility today

**Does.** Core features ship as toggleable blocks behind `plugins.*` settings.
The fenced-block renderer registry is data-shaped, and KaTeX math ships through
it.

**Guarantees.** Toggles gate *commands*, not derived state, so flipping one is
instant and cannot leave the index inconsistent. The gate is a single chokepoint
because there are several callers — the GUI, the CLI socket, and eventually a
plugin host. Rust defaults and the frontend registry are held in agreement by a
test that parses one against the other.

**Not built.** There is no plugin host at all. The block registry is the pre-ABI
*shape* of a plugin API — everything in it is first-party, in-process and
unsandboxed, and must not be treated as a sandbox boundary.

## 5. Non-functional requirements

**Performance.** A cold vault open plus full scan of a synthetic fixture, and a
full force-directed layout of a large graph, are both held to wall-clock ceilings
measured on a declared machine class. Ceilings sit at roughly twice the observed
median so they pass today, and they ratchet down and never up. Below its declared
machine class the gate refuses to assert rather than scaling by a guess. Vault
open returns as soon as the directory validates and the index opens, which is
what keeps open time independent of vault size. Numbers, method and harness are
owned by [`architecture/foundation.md`](architecture/foundation.md) §1 and are
deliberately not copied here.

**Concurrency.** Three lanes with strict separation, and crossing a boundary is
an explicit designed event: the webview main thread owns input and rendering and
in-memory state for focused notes only; Rust async owns all disk, database,
indexing and parsing work; Web Workers are reserved for WASM plugins. IPC
commands are coarse-grained and typed in both directions, because a chatty
fine-grained surface is a larger attack surface.

**Resilience.** Degrade rather than throw. A per-file failure is logged and
skipped. A corrupt index is rebuilt only if the rename journal reads cleanly —
a vault that will not open is recoverable by hand, a vault whose pending rewrites
were deleted is not. A dead file watcher is detected and reported rather than
silently restarted, because the honest repair is the rescan that reopening
already performs. Migrations are atomic and idempotent, a future schema is
refused untouched, and a shipped migration is never edited.

**Portability.** The vault survives the app being uninstalled and the company
disappearing. Nothing Cubical writes into a vault is required to read it. Asset
storage is per-vault and content-hashed; cross-vault deduplication is refused
because it breaks the ability to zip a vault and send it.

**Security and sandboxing.** All file I/O, parsing, indexing and CRDT work is
Rust-side behind a strict IPC allowlist. Third-party code will be sandboxed;
first-party features may use native capabilities, because sandboxing a feature
against the binary it ships inside is meaningless. Any feature whose *purpose* is
handing native capability to external code must satisfy all three gateway
conditions before it ships. `libsql` is pinned to its core feature set
specifically so the remote, replication and TLS stack never enters a build that
has no cloud to talk to.

**Cross-platform parity.** macOS, Linux and Windows are one tier — a feature
works on all three or it is not shipped, and a bug is equally serious wherever it
occurs. Parity is enforced structurally, not maintained by discipline: releases
are atomic across all three artifacts, platform-specific code sits behind a
single narrow seam so feature authors never write a platform conditional, and
every gate runs on every OS. Native *convention* may differ — the primary
modifier, menu placement, system dialogs — but capability may not. Details are
owned by [`architecture/distribution.md`](architecture/distribution.md).

**No legacy runtimes.** No Electron and no Node runtime in the shipped product.
Node, npm and Vite are build tooling, which is what that claim does and does not
cover.

### 5b. Unstated commitments

These are silences, not decisions. A contributor should not read their absence as
"already handled".

- **Frontend performance has no measured bar.** The commitment is "imperceptible"
  at the keystroke, the scroll and the search, but the only numbers that exist
  describe the engine. There is no keystroke-to-paint, scroll-frame or note-open
  budget. Filed as [#256](https://github.com/TheVaus/Cubical/issues/256).
- **No accessibility commitment exists** anywhere in the tree — no target
  standard, no keyboard-navigation guarantee, no screen-reader contract.
- **No internationalization strategy.** A UI string layer is reserved in the
  frontend; real translations are post-v1.0 and unscoped.
- **No positive privacy or telemetry policy.** There is a firm non-goal — nothing
  that ships content, file names or vault structure off-device — but no statement
  of what *is* collected, if anything.
- **No minimum OS versions.** The Linux floor is described as a mechanism (the
  glibc a release is built against, pinned by a build container) rather than as a
  version. macOS and Windows floors are unstated.
- **No update policy** beyond "one updater manifest per release".
- **No vulnerability-disclosure process** for a shipped app.
  [#125](https://github.com/TheVaus/Cubical/issues/125).
- **Nothing constrains how the app feels.** The non-negotiables cover
  correctness, portability and speed, and say nothing about interaction quality.
  [#263](https://github.com/TheVaus/Cubical/issues/263).

## 6. v1.0 — what "done" means

v1.0 cuts at the end of Layer 5. This section is exit criteria, not a schedule:
no dates and no ordering.

**Feature completeness.** The command and keymap registry and configurable
shortcuts have landed. Two named items remain: a theme picker in Settings
([#71](https://github.com/TheVaus/Cubical/issues/71)) and Copy-as-Markdown with
the sanitize seam it reserves
([#72](https://github.com/TheVaus/Cubical/issues/72)). The performance pass is
open.

**Correctness against our own guarantees.** Three open defects each contradict a
stated non-negotiable and must close before a release can honestly claim it:
CRLF files rewritten to LF ([#119](https://github.com/TheVaus/Cubical/issues/119)),
no filename validation so Windows-illegal names make a vault non-portable
([#122](https://github.com/TheVaus/Cubical/issues/122)), and no Unicode
normalization or path-length guard
([#123](https://github.com/TheVaus/Cubical/issues/123)).

**Platform parity.** The embedded terminal must work on Windows
([#99](https://github.com/TheVaus/Cubical/issues/99)); the modifier key must
abstract off macOS ([#100](https://github.com/TheVaus/Cubical/issues/100)); the
IPC transport must reach Windows via named pipes so the CLI can attach
([#114](https://github.com/TheVaus/Cubical/issues/114)); and a gate must forbid
platform conditionals outside the seam so parity cannot silently decay
([#115](https://github.com/TheVaus/Cubical/issues/115)), landed last so it
enshrines the end state rather than the conditionals being removed.

**Shippability.** There are no installers today; building from source is the only
way to run Cubical. The parent is
[#97](https://github.com/TheVaus/Cubical/issues/97) and it needs: real icons,
which are currently 1×1 placeholders
([#112](https://github.com/TheVaus/Cubical/issues/112)); a tag-triggered release
workflow producing all three artifacts from one commit
([#101](https://github.com/TheVaus/Cubical/issues/101)); macOS signing and
notarization ([#102](https://github.com/TheVaus/Cubical/issues/102)) and Windows
signing ([#103](https://github.com/TheVaus/Cubical/issues/103)); an auto-updater
and release manifest ([#104](https://github.com/TheVaus/Cubical/issues/104)); and
user-facing install documentation
([#105](https://github.com/TheVaus/Cubical/issues/105)).

**The one open business decision.** Signing vendors, their cost, and whether the
first Windows release ships unsigned are deliberately not recorded in the
architecture tree. They live in
[#96](https://github.com/TheVaus/Cubical/issues/96), and they gate the release
workflow.

**Not required for v1.0.** Layer 4's close tag is pending an operator GUI smoke
run, which is process rather than product. The bundle smoke job is push-only and
so has never run on a pull request, leaving `tauri build` unproven on all three
platforms ([#272](https://github.com/TheVaus/Cubical/issues/272)) — a release
blocker in practice even though it is not a feature.

## 7. Beyond v1.0 — described, not ordered

[`architecture/layers.md`](architecture/layers.md) retired the numbered ladder
deliberately: a written ordering implies a commitment nobody made, and an
ordering written down is an ordering that gets designed against. These five are
therefore unordered. Each states what it is and what it constrains *today*,
because that is the part that affects this week's work.

**Plugins — WASI/WASM ABI, JS via Javy, granular permissions.**
[#61](https://github.com/TheVaus/Cubical/issues/61). Third-party code in a WASM
sandbox with explicit capability grants; JavaScript remains a first-class *source*
language, never a runtime that bypasses the sandbox. Constrains today: the
fenced-block registry is its pre-ABI shape and must not be mistaken for a
boundary; the gateway conditions already bind any feature that would hand
capability outward. Open question that wants resolving *before* ABI design
starts: what key durable plugin state uses, given there is no file identity
before sync. The one ordering argument worth keeping — that an ABI is a one-way
door and wants a stable core beneath it — is recorded here as a note, not as a
position in a sequence.

**Sync — Loro CRDT, P2P, optional E2EE relay.**
[#62](https://github.com/TheVaus/Cubical/issues/62). Constrains today:
`cubical-sync` exports nothing and nothing may depend on it, because a dependency
on an empty crate constrains the design of whatever fills it; two schema names
are reserved and not created; and no file-identity UUID may be minted early "to
make later work easier". Onboarding is the single batch-write moment in a vault's
lifetime, and it is opt-in.

**Time Machine — sync-clean snapshots and version history.**
[#63](https://github.com/TheVaus/Cubical/issues/63). Constrains today: the
pre-sync safety net is the recovery directory, not a partial Time Machine. It
stays dormant rather than half-built.

**Canvas — a spatial surface.**
[#65](https://github.com/TheVaus/Cubical/issues/65). The open problem is that it
forces a file-format fork, which sits directly against the Markdown-only stance.
Unresolved, and the reason it is filed rather than planned.

**Mobile.** [#66](https://github.com/TheVaus/Cubical/issues/66). Not a v1 target,
but must not be precluded. Constrains today, and this is enforced: no crate other
than `cubical-app` may depend on Tauri. The CLI is standing proof the engine is
frontend-agnostic. The test is whether a change makes a non-app crate depend on a
desktop-only capability.

Graph view was on this list and is not any more — it shipped.

## 8. Out of scope

Deliberate non-decisions, owned by
[`architecture/constraints.md`](architecture/constraints.md). These are not
"later"; they are "no".

- A centralized cloud database for core storage. The vault is local.
- Cross-vault asset deduplication or global asset folders — it breaks the ability
  to zip a vault and send it.
- Proprietary file formats for content. Markdown only.
- Required user accounts.
- JavaScript plugin runtimes that bypass the WASM sandbox.
- Cross-app importers for Obsidian, Logseq or Notion. Community plugins can solve
  this; the core does not. This is also what lets the AST stay slim.
- Local AI, RAG or embeddings as a core feature. It is a plugin-ecosystem
  concern, and the index's vector capability is exposed to plugins that want it.
- Telemetry that ships content, file names or vault structure off-device.
  Crash reporting and aggregate usage stats may be opt-in, separately.
- Flatpak and Snap. Each carries a sandbox permission model in direct tension
  with opening an arbitrary directory anywhere on disk.
- Cross-vault search, and a cross-vault command palette.

Rejected approaches are recorded so the rationale does not have to be
re-litigated: end-of-file HTML-comment UUIDs, a four-tier external-edit recovery
waterfall, and a `.cubical/quarantine/` directory.

## 9. Known gaps and risks

Where the product does not currently keep its own promises, or where the
documentation asserts something untrue. This section is the reason the document
is worth reading.

**Guarantees currently broken in shipped code.**

- The byte-for-byte promise is not held for CRLF files: the editor has no line
  separator configured, so opening a CRLF note and typing one character rewrites
  the whole file to LF. [#119](https://github.com/TheVaus/Cubical/issues/119).
- Portability is not held for filenames: there is no validation, so a vault can
  contain names that cannot be extracted on Windows
  ([#122](https://github.com/TheVaus/Cubical/issues/122)), and no Unicode
  normalization or path-length guard
  ([#123](https://github.com/TheVaus/Cubical/issues/123)).
- Typed properties store a property's type as an inline `# type:` comment in the
  `.md`, which puts app metadata in the source of truth against the
  non-negotiables. It ships default-off and the replacement is a vault-level
  registry, but it ships. [#19](https://github.com/TheVaus/Cubical/issues/19).

**Weaker on one platform than the parity rule implies.** Windows has no file
identity, so a rename made while the app was closed *and* which also edited the
file cannot be paired; pairing falls back to content hashing, which is refused
when two files share a hash — something empty notes and templates make ordinary.
[#220](https://github.com/TheVaus/Cubical/issues/220). This is recorded as a
known limit rather than a bug, which is the honest framing, but it is a
capability gap and the distribution rule says capability gaps are not allowed.

**Documentation that is stale or contradictory.**

- [`architecture/planned.md`](architecture/planned.md) §6 still records the
  licence as "MIT placeholder during alpha". The repo ships under the Business
  Source License 1.1, and no file in this tree records that decision — only the
  root README mentions it. A locked architecture document is wrong about the
  licence.
- `layers.md` retired the L6–L10 ladder, but the numbering survives elsewhere as
  residual vocabulary: `foundation.md` still labels graph rendering "Layer 9" and
  `ui.md` names L6, L7 and L8 settings categories. These read as live commitments
  and are not.
- The status of the design-system inline-control tail
  ([#34](https://github.com/TheVaus/Cubical/issues/34)) is stated as complete in
  one document and as outstanding in another.
- Architecture documents describe locked design rather than shipped state, which
  is correct but reads as description of the present — `ui.md` discusses the
  theme picker as though it exists, and it has not been started.

**Process and infrastructure risk.**

- No release has ever been built. The bundle smoke job runs only on push, so
  `tauri build` is unproven on all three platforms
  ([#272](https://github.com/TheVaus/Cubical/issues/272)).
- Several known flakes make CI signal ambiguous, including a Windows teardown
  segfault that blames whichever pull request happens to hit it.
- The documentation checker detects duplication, not contradiction. A green run
  means no fact is stated twice; it never means the documents agree. Everything
  in this subsection is exactly the class it cannot catch — and this file, which
  restates by design, enlarges that class.

## 10. Keeping this document true

Update this file when the *product* changes: a capability ships, an exit
criterion closes, a non-goal is added, or a gap in §9 is fixed or found. Do not
update it when an implementation detail changes.

Never restate here: the performance numbers, layer status, the platform table or
the index schema. Those four have owners, the checker enforces them, and all four
move.

Future work belongs in a GitHub issue, never in prose here — that is why there is
no roadmap section and why §7 links out for every item. A document describing
work in progress goes stale the moment the work changes, and nothing makes anyone
notice.
