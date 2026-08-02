# best-effort-resilience — One bad file must never abort a scan

**Rule:** Every per-file refresher logs and continues on failure.

**Gate:** none.

**Why:** A vault is user data, and user data is malformed. If a single unparseable file can abort a scan or take the watcher dispatcher down, one bad note bricks the whole vault — the opposite of the sovereignty commitment. Failing soft means the next scan or modify event heals the file once it is fixed, with no user intervention and no special recovery path.

**Exceptions:** none for per-file work (frontmatter, links, tags, blocks, search). This does **not** license swallowing errors in vault-wide operations, where a failure that is genuinely global should surface rather than degrade silently.

**Detail:** [`../implementation/README.md`](../implementation/README.md) → Cross-cutting rules.
