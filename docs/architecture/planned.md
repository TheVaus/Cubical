> Locked decisions. Architecture review required to change. Index: [docs/architecture/README.md](README.md)

# Cubical — Constraints from unbuilt layers

**This file holds only what constrains work happening today.** Everything else
that used to live here — the full Loro design, the plugin ABI versioning
scheme, the Time Machine snapshot shape — moved to unscheduled GitHub issues,
because a detailed design for something nobody is building is a design that
rots unread and then gets believed.

The test each entry passed: **does this change what I am allowed to do this
week?** If the answer is "only once we build it", it is an issue.

| Was | Now |
|---|---|
| §7 Sync (Loro, op logs, WebRTC, asset pipeline) | [#62](https://github.com/TheVaus/Cubical/issues/62) |
| §8 Plugins (ABI, source languages, permissions, memory, themes) | [#61](https://github.com/TheVaus/Cubical/issues/61) |
| §10 Time Machine | [#63](https://github.com/TheVaus/Cubical/issues/63) |
| §14 open questions, per topic | the matching issue |

---

## 1. Do not preclude mobile

Desktop only for v1 — but the architecture must not close the door. In
practice that is one enforceable rule and one habit:

- **Only `cubical-app` may depend on Tauri.** Every other crate stays buildable
  and testable without the desktop harness. Enforced by
  `scripts/gates/dependency_boundary.py`; the rule is
  [`../principles/crate-separation.md`](../principles/crate-separation.md).
- The engine is a **library first**. `cubical-engine` is transport-agnostic and
  `cubical-cli` exists as standing proof — a second frontend that works. A
  mobile shell would be a third.

The practical test: a change that makes a non-app crate depend on a
desktop-only capability has precluded mobile. Detail: [#66](https://github.com/TheVaus/Cubical/issues/66).

## 2. Reserve the sanitize seam

Export sanitization is Layer 5 work, but the seam it needs is a **constraint now**:
anything that renders or exports document content must route through a single
point where sanitization can later be inserted. Scattering render-to-output
across call sites means the seam has to be retrofitted into each one.

## 3. `cubical-sync` exports nothing

The crate exists as a planned interface with **no implementation and no public
items** until `trait CrdtBackend` and Loro land. Nothing may depend on it — a
dependency on an empty crate is dead weight that later constrains the design of
the thing that fills it.

Verified by [`../implementation/README.md`](../implementation/README.md) →
Cross-cutting rules.

## 4. No file-identity UUIDs before sync onboarding

A non-negotiable, restated here only because it is the constraint most likely
to be violated *by* unbuilt-layer thinking: the sync design keys everything on
`file_uuid`, and it is tempting to mint them early to make later work easier.

The vault stays byte-for-byte the user's until they opt into sync. Pre-sync
reconciliation uses the hash + mtime model in
[`vault.md`](vault.md) §4.3, and the pre-sync safety net is
`.cubical/recovery/` — **not** a Time Machine, which is dormant rather than
partial until there is a CRDT layer to be clean relative to.

The open question this creates for the plugin ABI — what key durable plugin
state uses before `file_uuid` exists — is the unresolved part of
[#61](https://github.com/TheVaus/Cubical/issues/61), and it wants an
`arch-review` before ABI design starts, not after.

## 5. Reserved schema names

`crdt_operations` and `crdt_snapshots` are **reserved** in the index schema and
not created. Do not reuse the names for anything else.

## 6. Still genuinely undecided, and not owned by any issue

These are architectural questions that will be forced eventually and have no
home yet. Each becomes its own section here, written before any code, when it
goes live:

- **Encryption at rest** for `.cubical/index.db` and `.cubical/recovery/`. The
  architecture should not preclude it.
- **i18n strategy.** A UI string layer will be reserved in the frontend; real
  translations are post-v1.0.
- **Backup / corruption recovery** for `.cubical/index.db` — rebuild from `.md`
  versus a built-in backup tool. Mostly documentation rather than architecture,
  but the trade-off deserves deciding.
- **License / business model.** MIT placeholder during alpha.

## 7. Shipped, but parked — read before building on them

Two features are merged and therefore easy to mistake for settled foundations.

**Typed properties** are shipped and **defaulted off**
(`properties.typed_enabled` absent → false). The v1 stores a property's type as
an inline `# type:` comment, which puts app metadata in the `.md` source of
truth against the non-negotiables. The intended replacement is a vault-level
type registry in `.cubical/`. **Build the registry before promoting typed
properties default-on, or letting sort / query / Dataview depend on type
storage** — issue [#19](https://github.com/TheVaus/Cubical/issues/19).

**Property-reference interpolation** is shipped and default-on
(`plugins.property_refs_enabled`). Inline, read-only, display-time
interpolation of a frontmatter scalar: `[[Gandalf.age]]` cross-file and
`[[.age]]` self. The dot is the property separator, so dotted note names are
not `[[ ]]`-linkable. v1 renders the **raw scalar**, so it takes no dependency
on the typed-properties registry and can evolve independently; type-aware
formatting is a later additive layer that *would* lean on the registry.

Frontmatter **stays YAML** — native scalar and date types, ecosystem-portable.
That is not up for revisiting as part of either feature.
