# Cubical — Documentation

The docs index. The session primer is [`CLAUDE.md`](../CLAUDE.md) — start there.
`CLAUDE.md` auto-loads every session; everything else is loaded on demand.

## What kind of question do you have?

| Question | Read |
|---|---|
| What rule constrains this task? | [`principles/README.md`](principles/README.md) — every rule in one table, then open only the file you need |
| What's locked architecturally? | [`architecture/README.md`](architecture/README.md) — split by domain |
| Why is this code written this way? What invariant does it hold? | [`implementation/`](implementation/) — split by domain |
| What exists right now — crates, IPC surface, DS components? | [`generated/`](generated/) + [`../design-system/INVENTORY.md`](../design-system/INVENTORY.md) |
| Which layers are closed? What did each deliver? | [`architecture/layers.md`](architecture/layers.md) |
| How does opening a note / tab / link actually work? | [`architecture/navigation.md`](architecture/navigation.md) |
| How fast must it be? How do I measure it? | [`architecture/foundation.md`](architecture/foundation.md) §1 (commitment 2) |
| What constrains me today because of a layer we haven't built? | [`architecture/planned.md`](architecture/planned.md) |
| What's been explicitly cut from scope? | [`architecture/constraints.md`](architecture/constraints.md) |
| What should we build next? What's broken? | GitHub Issues — **not a file in this tree** |
| How do we use Issues, labels and PRs? | [`principles/sessions.md`](principles/sessions.md) |
| User wants a `.gitignore` for their vault | [`vault-gitignore.md`](vault-gitignore.md) |
| What did we used to think? | [`archive/`](archive/) — frozen, never current truth |

## The four tiers

Everything here is in exactly one of these. If you cannot tell which tier a new
fact belongs to, that is the signal to ask, not to start a fifth.

1. **`principles/`** — the rules. One file per rule, fixed skeleton, stable id,
   and the gate that enforces it. A gate failure names its principle file.
2. **`architecture/`** — locked decisions, changeable only by architecture
   review. The code-versus-doc precedence rule is owned by
   [`architecture/README.md`](architecture/README.md).
3. **`implementation/`** — why the code is shaped the way it is. This tier
   exists *because* rationale is banned from source comments; it is held honest
   by the `symbol-anchors` gate.
4. **`generated/`** — what exists right now. Never hand-written, always
   reproducible. Regenerate rather than edit.

Plus **`archive/`**, which is frozen history and current truth about nothing.

## Generated artifacts

Never hand-written; each carries a do-not-edit banner, accepts `--check`, and
reproduces byte-identically. A doc in any other tier may **not** restate what a
generator produces — link instead.

| Artifact | Generator | Answers |
|---|---|---|
| [`generated/repo-layout.md`](generated/repo-layout.md) | `scripts/gen_repo_layout.py` | What crates and directories exist, and which are Tauri-free |
| [`generated/ipc-surface.md`](generated/ipc-surface.md) | `scripts/gen_ipc_surface.py` | Every `#[tauri::command]` and the `cubical-ipc` wire types |
| [`../design-system/INVENTORY.md`](../design-system/INVENTORY.md) | `scripts/gen_ds_inventory.py` | What DS components exist — **read before hand-rolling a control** |
| [`principles/README.md`](principles/README.md) | `scripts/gen_principles_readme.py` | Every rule in one table, with its gate |

The rule is [`principles/generated-artifacts.md`](principles/generated-artifacts.md).

## Doc discipline

**Every fact has exactly one owner; every other doc links to it rather than
restating it.** The rule is
[`principles/single-owner-facts.md`](principles/single-owner-facts.md), and the
table below is its data — `scripts/check_docs.py` reads the fenced block
directly, so the table and the enforcement cannot drift apart.

Three structural rules:

- **`CLAUDE.md` is a router, not a record.** It auto-loads every session, so it
  carries only identity, non-negotiables, the contract, pointers and a ≤3-line
  Now block. It has a **word** budget, not a line budget: it once ran to 1,551
  words in 58 lines and passed a 65-line check while being the most expensive
  file in the repo to load.
- **`archive/**` is frozen.** It records what was believed at the time. Do not
  edit it to "correct" it — a corrected record is no longer a record. It is
  exempt from the ownership and count rules for exactly that reason.
- **In-flight design lives in a GitHub issue**, never in this tree. That is why
  there is no `work/` directory: a document describing work in progress goes
  stale the moment the work changes, and nothing makes anyone notice.

### Ownership

<!-- The block below is DATA, read by scripts/check_docs.py. Columns:
     fact-id · owner-path · detection-pattern (a Python regex, or "-" for none).
     A doc other than the owner matching the pattern is a violation.
     Add a row when you add a fact worth owning; the checker picks it up with
     no code change. -->

```ownership
what-cubical-is           | CLAUDE.md                                  | -
session-contract          | CLAUDE.md                                  | -
current-focus             | CLAUDE.md                                  | -
doc-map                   | docs/README.md                             | -
ownership-table           | docs/README.md                             | ^\x60\x60\x60ownership
repo-layout               | docs/generated/repo-layout.md              | -
ipc-surface               | docs/generated/ipc-surface.md              | -
ds-inventory              | design-system/INVENTORY.md                 | -
db-schema                 | docs/architecture/document-model.md        | CREATE TABLE (?:links|tags|pending_rewrites|files|frontmatter|blocks)\b
doc-wins-precedence       | docs/architecture/README.md                | the doc wins
layer-status              | docs/architecture/layers.md                | l4a.*l4b.*l4c
perf-bar                  | docs/architecture/foundation.md            | \b13\s*s\b.{0,40}10,?000|10,?000 notes.{0,40}\b13\s*s\b
native-capability-gateway | docs/architecture/foundation.md            | -
setting-keys              | ui/src/api/ipc.ts                          | -
viewer-formats            | ui/src/viewer/viewerKind.ts                | -
settings-storage-routing  | docs/architecture/ui.md                    | -
ds-bespoke-prose          | docs/architecture/ui.md                    | -
ds-raw-control-budgets    | scripts/ds-raw-controls.json               | -
component-size-budgets    | scripts/component-budgets.json             | -
app-shell-rule            | docs/architecture/ui.md                    | -
tauri-boundary-exceptions | scripts/dependency-boundary.json           | -
declared-runtime-deps     | scripts/techstack-declared.json            | -
perf-budget-machine-class | scripts/perf-budget.json                   | -
out-of-scope-nonfeatures  | docs/architecture/constraints.md           | -
unbuilt-layer-constraints | docs/architecture/planned.md               | -
impl-invariants           | docs/implementation/                       | -
the-rules                 | docs/principles/                           | -
gate-list                 | scripts/check.sh                           | -
issue-taxonomy            | docs/principles/sessions.md                | -
ci-definition             | .github/workflows/ci.yml                   | -
issue-templates           | .github/ISSUE_TEMPLATE/                    | -
pr-contract               | .github/pull_request_template.md           | -
```

### What the checker cannot do

`scripts/check_docs.py` detects **duplication**, not **contradiction**. It finds
the same fact stated twice; it cannot find two statements that are each
internally consistent and mutually incompatible.

The rustdoc mandate that triggered this rework is the worked example: one doc
required rustdoc on public items while another banned all doc-comments, and the
two halves shared no detectable pattern. Nothing automatic would have caught it.

The only real mitigation is **surface-area reduction** — fewer docs, fewer
words, fewer places a contradiction can hide. That is the reason for the tier
count, the primer word budget, and the archive.
