# Security policy

Cubical is a desktop application over a local vault of `.md` files. It ships no
server, no accounts and no cloud component, so there is no hosted surface to
report against — everything below concerns the application and the vault on
your own machine.

## Reporting a vulnerability

**[Report a vulnerability](https://github.com/TheVaus/Cubical/security/advisories/new)**
from the Security tab. That opens a private advisory the maintainer can see and
you can discuss in, before anything is public.

Please do not open a public issue for a suspected vulnerability, and do not
attach a proof-of-concept vault to one. Report it even if you are not sure it is
real; a wrong report costs a reply, a public one costs a disclosure window.

This is a single-maintainer project — expect an answer in days rather than
hours. There is no bounty.

## Versions

Pre-1.0, and nothing is released yet: `main` is the only supported version, and
a fix ships forward rather than being backported.

## What is most worth looking at

Not a scope boundary — a hint at where the interesting failures live:

- **Anything that stops a vault file being data.** A `.md` file, a link target
  or a rename that escapes the vault directory, executes something, or reaches
  a resource the vault does not own.
- **The plugin sandbox and the capability gateway.** Third-party plugin code is
  sandboxed and native capability is meant to be opt-in and auditable — see
  [`native-capability-gateway`](../docs/principles/native-capability-gateway.md).
  A plugin obtaining capability it was not granted is the highest-value bug in
  the project.
- **The embedded terminal**, which is a real PTY with real process authority.

Bugs where the vault's own owner is the attacker against their own machine are
generally not vulnerabilities — you already have a shell. What matters is
content you did not write reaching authority you did not grant.
