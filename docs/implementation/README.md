# Cubical — Implementation notes

Load-bearing **implementation** invariants: the non-obvious rules a change can
silently break. These were previously carried as long-form comments in the
source; the code now stays comment-free and this tree is their owner.

## Scope boundary

This tree is deliberately a different granularity from its neighbours:

| Tree | Owns |
|---|---|
| [`../architecture/`](../architecture/) | Locked design decisions — what Cubical *is*, changeable only by architecture review |
| `layer-N-spec.md` | Per-layer intent + what landed, frozen at layer close |
| [`../conventions.md`](../conventions.md) | Code style, commits, test + session process |
| **this tree** | Why a given implementation is written the way it is — invariants, ordering constraints, resilience policy, platform quirks |

A fact lives in exactly one place. Where a rule is already owned by an
architecture doc or a spec, these notes link to it rather than restating it.

## Map

| Area | Notes |
|---|---|
| Canonical AST, tokenizers, parity harness | [`ast.md`](ast.md) |
| Vault, scan, watcher, refreshers, rename journal | [`vault-core.md`](vault-core.md) |
| Engine command/event layer + IPC | [`engine-ipc.md`](engine-ipc.md) |
| libSQL index, Tantivy search, dataview queries | [`search-index.md`](search-index.md) |
| Frontend state, editor, decorations | [`frontend.md`](frontend.md) |
| Stylesheet layering + design-system boundary | [`styling.md`](styling.md) |

## Cross-cutting rules

- **Crate roles and the no-Tauri boundary** are owned by
  [`../README.md`](../README.md) → Repository layout and
  [`../migration-touchpoints.md`](../migration-touchpoints.md). The engine
  (`cubical-engine`) holds all logic; `cubical-app` is the Tauri shell and the
  rewrite boundary; `cubical-cli` exists as standing proof the engine is
  frontend-agnostic.
- **Best-effort resilience.** Every per-file refresher (frontmatter, links,
  tags, blocks, search) logs and continues on failure. One malformed file must
  never abort a scan or take the watcher dispatcher down; the next scan or
  modify event heals it.
- **Derived state is disposable.** The rebuildable cache in `.cubical/`
  (`index.db`, `search/`, `recovery/`) is derivable from the `.md` files — with
  one exception, the pending-rewrites queue, which is why the durable rename
  journal exists (see [`vault-core.md`](vault-core.md)). `config.toml` and
  `themes/` are durable user config, not derived state; the split is owned by
  [`../architecture/vault.md`](../architecture/vault.md) §3.
- **`cubical-sync` is an empty placeholder.** It has no public items until the
  `CrdtBackend` trait + Loro land at L7
  ([`../architecture/planned.md`](../architecture/planned.md)). Nothing depends
  on it — a dependency on it would be dead weight, so don't add one back until
  the crate actually exports something.
