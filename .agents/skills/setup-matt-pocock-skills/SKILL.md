---
name: setup-matt-pocock-skills
description: "Verify and repair the tracker configuration the triage and wayfinder skills read. Run once after installing them, and again whenever the label vocabulary or its owning doc changes."
disable-model-invocation: true
---

# Skill configuration — verify and repair

Upstream, this skill *scaffolds* config into `docs/agents/`. Here it does not:
Cubical already owns every fact it would have written, and a fifth doc tier is
exactly what [`docs/README.md`](../../../docs/README.md) tells you not to start.
So this skill **verifies** the existing owners and **repairs** the one thing that
lives outside the tree — the GitHub label vocabulary.

## Where the config already lives

| What the skills need | Owner |
|---|---|
| Issue tracker, label vocabulary, milestone meaning, blocking convention | [`docs/principles/sessions.md`](../../../docs/principles/sessions.md) |
| Issue shapes (`feature` · `bug` · `idea` · `perf-debt` · `arch-review`) | `.github/ISSUE_TEMPLATE/` |
| Domain vocabulary and locked decisions | [`docs/architecture/README.md`](../../../docs/architecture/README.md) |
| Why the code is shaped this way | [`docs/implementation/`](../../../docs/implementation/) |
| What is already ruled out of scope | [`docs/architecture/constraints.md`](../../../docs/architecture/constraints.md) |

There is no `docs/agents/`, no `CONTEXT.md` and no `docs/adr/`. Do not create
them. If a skill asks you for one, read the row above it instead.

## Verify

1. Every path in the table above exists.
2. `docs/principles/sessions.md` still carries the label table, including the
   `needs-*` / `ready-*` and `wayfinder:*` rows. If those rows are gone, the
   skills have no vocabulary — restore them there, not here.
3. `gh label list` covers the vocabulary. Missing labels are the common case
   after a fresh clone of the tracker; repair them below.
4. `python3 scripts/check_docs.py` is green. A skill file is tracked Markdown
   and is checked like any other doc: its links must resolve, and it may not
   restate a fact the ownership table assigns elsewhere.

## Repair the labels

Run only for labels `gh label list` does not already show. Never rename or
recolour an existing label — the label table owns those strings, and a rename
silently orphans every issue carrying the old one.

```bash
gh label create needs-triage   --color fbca04 --description "Triage started, not finished"
gh label create needs-info     --color d876e3 --description "Blocked on an answer a human has to give"
gh label create ready-for-agent  --color 0e8a16 --description "Specified enough for an AFK agent to take"
gh label create ready-for-human  --color 5319e7 --description "Specified, but needs a human to implement"
gh label create wayfinder:map      --color 1d76db --description "A wayfinder map: the index issue for one foggy effort"
gh label create wayfinder:research --color c5def5 --description "Wayfinder ticket: a fact an explorer can find"
gh label create wayfinder:prototype --color c5def5 --description "Wayfinder ticket: build something cheap to react to"
gh label create wayfinder:grilling  --color c5def5 --description "Wayfinder ticket: a decision only the operator can make"
gh label create wayfinder:task      --color c5def5 --description "Wayfinder ticket: manual work unblocking a decision"
```

`bug`, `enhancement`, `wontfix` and `blocked` already exist and are reused as-is.

## What this skill deliberately does not do

- **Write to `CLAUDE.md`.** It is a router with a word budget the docs gate
  enforces. The pointer to these skills is already in it; nothing else goes.
- **Create a triage queue.** `needs-triage` marks work you have started
  triaging. It is never applied in bulk, and no issue is ever swept into it
  for age — [`sessions.md`](../../../docs/principles/sessions.md) owns why.
- **Turn on PRs as a request surface.** Cubical's PRs are its own and
  Dependabot's; neither is a request. Leave it off.

## Local edits

Rewritten from scaffolding to verification. Upstream writes `docs/agents/*.md`,
a `## Agent skills` block in `CLAUDE.md`, `CONTEXT.md` and `docs/adr/`; all four
would create a second owner for a fact this repo already owns. Preserve this
shape when re-syncing against upstream.
