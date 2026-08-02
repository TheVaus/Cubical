# native-capability-gateway — A gateway feature must be opt-in, harmless when abused, and auditable

**Rule:** Any feature whose purpose is handing an unsandboxed capability to arbitrary external code must satisfy all three conditions before it ships.

**Gate:** none.

**Why:** The plugin sandbox governs **third-party** code. Sandboxing a first-party feature against the binary it ships inside is meaningless, so first-party features may use native capabilities. But a feature that hands that capability *onward* to arbitrary code is not a normal feature — it is a gateway, and the three conditions replace the sandbox for it: **opt-in and default-off** (a `plugins.*` toggle), **unable to compromise vault integrity when abused** (the vault converges on whatever the external code leaves behind), and **auditable** (effects land in `audit_log`). Without this rule, "core features are exempt from the sandbox" would eventually justify a core feature doing anything at all.

**Exceptions:** none. The embedded terminal is the motivating case and meets all three — it spawns child processes at least as untrusted as any community plugin, since `npx some-tool` has passed through nothing while a plugin at least passed the WASI ABI.

**Detail:** [`../architecture/foundation.md`](../architecture/foundation.md) §2.1.
