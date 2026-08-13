> Locked decisions. Architecture review required to change. Index: [docs/architecture/README.md](README.md)

# Cubical — Distribution

**Owner of platform tiers.** Which operating systems Cubical ships to, what a
user is promised on each, and which packaging formats exist. Nothing else
restates this table — link to it.

"Desktop only for v1" is owned by [`planned.md`](planned.md) §1 and is not
repeated here. This file answers the question that rule leaves open: *which
desktops*, and *with what promised.*

## 1. Tiers

| Platform | Tier | Promised | Status |
|---|---|---|---|
| macOS (Apple Silicon + Intel) | 1 | Every shipped feature | Gate set green |
| Linux (x86_64) | 1 | Every shipped feature | Gate set green |
| Windows (x86_64) | 2 | Everything except the CLI bridge and the embedded terminal | **Build unconfirmed** — [#110](https://github.com/TheVaus/Cubical/issues/110) |

**Tier 1** means a feature is not "shipped" until it works there. **Tier 2**
means the app installs, opens a vault, and edits notes, with a named and
documented set of absences.

The Windows row is a **target, not a description of today.** `libsql-sys 0.8`
used a Unix-only API unconditionally, so the workspace did not compile on
Windows at all. The pin now resolves to 0.9.30, which gates that call by target,
but the known blocker being removed is not the same fact as a green build: only
a Windows CI run proves that, and none has passed yet. The status column exists
so this file cannot quietly describe an intention as if it were a fact. Tracked
in [#110](https://github.com/TheVaus/Cubical/issues/110).

The split is not arbitrary and is not a judgement about users. It follows the
code that already exists: `cubical-ipc` is built on Unix domain sockets, so the
CLI socket attach is Unix-shaped down to its transport. Promoting Windows to
tier 1 means porting that transport to named pipes — a real piece of work that
buys the feature a Windows note-taker reaches for last.

The rejected alternative was full parity at v1.0. It puts a transport port on
the critical path of a first release, which is the single largest way this
project could multiply its own workload for the smallest reach.

## 2. What a tier-2 gap must be

A gap is a **deliberate, visible absence** — never a silent failure. Three
requirements, all of them load-bearing:

- The surface degrades gracefully. A missing capability may be hidden or
  disabled with a reason. It may not present a control that hangs, crashes, or
  does nothing.
- The absence is stated where a user meets it, not only in a doc they will never
  open.
- The gap is an open issue, so it has a state and a close event rather than
  living as permanent prose.

A tier-2 platform is a promise about *scope*, never about *quality*. A crash on
Windows is a bug at exactly the severity it would be on macOS.

## 3. Packaging formats

| Platform | Formats |
|---|---|
| macOS | `.dmg`, universal binary |
| Linux | `.AppImage`, `.deb` |
| Windows | `.msi` |

Flatpak and Snap are **out of scope**, and this is a rejection rather than a
deferral. Each is a separate manifest with its own review process and its own
sandbox-permission model, and that model is in direct tension with the
non-negotiable that the vault is portable and self-contained: Cubical must open
an arbitrary directory the user chooses, anywhere on disk. Fighting a sandbox
for that permission, twice, buys very little over an AppImage that already runs
everywhere.

A universal macOS binary is chosen over separate Intel and Apple Silicon
downloads deliberately: build time is paid once by CI, whereas asking every user
to identify their own CPU is a support burden that never ends.

## 4. The support floor is a container decision

The oldest Linux a release must run on is set by the **glibc it is built
against**, and therefore must be pinned by a build container — never by a CI
runner label.

A runner label looks like it pins the floor and does not. GitHub retires runner
images on its own schedule (the Ubuntu 22 images begin deprecation on
2026-09-17), so a floor expressed as a label silently rises whenever an image is
retired, and the only signal is old installs failing to launch after an upgrade
nobody connected to the cause.

This is why the gate matrix and the release build legitimately differ: the gate
matrix only proves the workspace compiles and passes, so it tracks whatever
image is current. The release build pins its own floor.

## 5. Not decided here

Code signing — vendors, cost, and whether v1.0 ships unsigned on Windows — is a
business decision with a bill attached, and stays in
[#96](https://github.com/TheVaus/Cubical/issues/96) until it is made. It is
deliberately absent from this file: a locked architecture doc should record
decisions that were actually taken, not the ones an implementer wishes existed.
