> Locked decisions. Architecture review required to change. Index: [docs/architecture/README.md](README.md)

# Cubical — Distribution

**Owner of platform support.** Which operating systems Cubical ships to, what a
user is promised on each, how the three are kept identical, and which packaging
formats exist. Nothing else restates this — link to it.

"Desktop only for v1" is owned by [`planned.md`](planned.md) §1 and is not
repeated here. This file answers the question that rule leaves open: *which
desktops*, and *with what promised.*

## 1. One tier

| Platform | Support |
|---|---|
| macOS (Apple Silicon + Intel) | First-class |
| Linux (x86_64) | First-class |
| Windows (x86_64) | First-class |

**There is no second tier, and adding one requires architecture review.** A
feature works on all three or it is not shipped. A bug is the same severity
wherever it occurs. A user moving between machines should not be able to tell
which operating system the app was developed on.

This replaces an earlier decision that made Windows a deliberate second tier,
missing the CLI bridge and the embedded terminal. That decision was argued almost
entirely on cost — it kept a transport port off the critical path of a first
release. The cost was real, but a permanently second-class platform is a
recurring cost of its own: it splits the feature matrix, it makes every future
feature ask "and on Windows?", and it lets the transport layer stay shaped by
whichever platform happened to be implemented first. The work is accepted.

## 2. Parity is enforced, not maintained

The thing that kills cross-platform products is not the initial port. It is the
slow divergence afterwards, where each platform accumulates its own fixes and
somebody has to keep chasing them back into line. Three mechanisms exist so that
parity is a property of the system rather than an ongoing effort.

**Releases are atomic.** One tag produces artifacts for all three platforms, from
one commit, carrying one version number, served by one updater manifest. There is
no such thing as a macOS-only release. If a platform cannot build, the release
does not go out — the fix is to fix the platform, never to ship without it. This
is what makes "I updated on one machine, why is the other one different?"
structurally impossible rather than merely unlikely.

**One shared implementation, one narrow seam.** Effectively all of Cubical is
already platform-agnostic: the engine is portable Rust and the interface is a
webview. Platform-specific code is therefore the exception and must stay
confined to a small, named set of locations, behind a single abstraction with one
implementation per platform. A feature author must never write a platform
conditional. Scattering `#[cfg(unix)]` through feature code is how a codebase
arrives at three divergent products sharing a repository.

**CI is the enforcement.** Every gate runs on all three operating systems, so a
platform break fails at review time rather than at release. Discipline does not
keep platforms aligned; a red build does.

## 3. What "feels the same" does not mean

Identical behaviour, not identical convention. Cubical follows each platform's
native conventions where a user would be confused by their absence: the primary
modifier is Cmd on macOS and Ctrl elsewhere, menus sit where that platform puts
them, and file dialogs are the system's own.

The distinction is that these are **presentation** differences over one shared
behaviour, never differences in what the app can do. A shortcut renders
differently and performs the same command. Nothing in this section licenses a
capability existing on one platform and not another.

## 4. Packaging formats

| Platform | Formats |
|---|---|
| macOS | `.dmg`, universal binary |
| Linux | `.AppImage`, `.deb` |
| Windows | `.msi` |

Flatpak and Snap are **out of scope**, and this is a rejection rather than a
deferral. Each is a separate manifest with its own review process and its own
sandbox-permission model, and that model is in direct tension with the
non-negotiable that the vault is portable and self-contained: Cubical must open
an arbitrary directory the user chooses, anywhere on disk. Fighting a sandbox for
that permission, twice, buys very little over an AppImage that already runs
everywhere.

A universal macOS binary is chosen over separate Intel and Apple Silicon
downloads deliberately: build time is paid once by CI, whereas asking every user
to identify their own CPU is a support burden that never ends.

## 5. The support floor is a container decision

The oldest Linux a release must run on is set by the **glibc it is built
against**, and therefore must be pinned by a build container — never by a CI
runner label.

A runner label looks like it pins the floor and does not. GitHub retires runner
images on its own schedule, so a floor expressed as a label silently rises
whenever an image is retired, and the only signal is old installs failing to
launch after an upgrade nobody connected to the cause.

This is why the gate matrix and the release build legitimately differ: the gate
matrix only proves the workspace compiles and passes, so it tracks whatever image
is current. The release build pins its own floor.

## 6. Not decided here

Code signing — vendors, cost, and whether the first release ships unsigned on
Windows — is a business decision with a bill attached, and stays in
[#96](https://github.com/TheVaus/Cubical/issues/96) until it is made. It is
deliberately absent from this file: a locked architecture doc should record
decisions that were actually taken, not the ones an implementer wishes existed.
