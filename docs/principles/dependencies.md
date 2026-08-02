# dependencies — Pinned, grouped, and narrowed to what ships

**Rule:** Pin third-party Actions to commit SHAs, keep the Rust toolchain pinned, and enable only the features you use.

**Gate:** `scripts/check.sh` + CI; Dependabot opens weekly update PRs, each CI-gated like any other.

**Why:** Mutable tags are a supply-chain hole, and pinning Actions to SHAs is the same stance the plugin sandbox takes applied to the build. Pinning the toolchain means `clippy -D warnings` shifts only when someone bumps it deliberately, not whenever a new stable ships. Narrowing features is not cosmetic: `libsql` is pinned to `core` specifically so the remote/replication/TLS stack — and its CVE surface — never enters a build that has no cloud to talk to.

**Exceptions:** An advisory may be deferred **with a recorded cause** — genuinely upstream-blocked, or platform-irrelevant. "Deferred" is not "ignored": the cause is written down and revisited. Alert IDs are not issue numbers and must not be written as `#N`.

**Detail:** `.github/dependabot.yml`, `rust-toolchain.toml`, and `scripts/techstack-declared.json` (the declared runtime set).
