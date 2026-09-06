---
name: wayfinder
description: Chart a chunk of work too big for one session as a map of decision tickets on the tracker, then resolve them one at a time until the way to the destination is clear. Use for a foggy effort where the decisions are not yet visible, not for a feature you already know how to build.
disable-model-invocation: true
---

# Wayfinder

A loose idea has arrived, too big for one session, and wrapped in fog: the way
from here to the **destination** is not visible yet. Wayfinding finds that way.
It charts the route as a **map** on the tracker, then works its **decision
tickets** — questions whose resolution is a decision, not slices of a build —
one at a time, until nothing is left to decide.

The tracker conventions this skill leans on are owned by
[`sessions.md`](../../../docs/principles/sessions.md): native sub-issues for
decomposition, `Blocked by #N` plus the `blocked` label for dependencies, no
milestone unless the work is genuinely scheduled. If the `wayfinder:*` labels do
not exist, run `/setup-matt-pocock-skills`.

## Plan, don't do

Each ticket resolves a decision. The map is done when the way is clear and
someone can go build. **The pull to just start building is the signal you have
reached the edge of the map** — that is the moment to hand off, not to press on.
An effort can override this in its Notes; absent that, produce decisions.

This is also why a wayfinder ticket is never labelled `idea`. An `idea` is a
permanent record carrying *what* and never *when*, which nothing sweeps or
closes. A ticket here is the opposite: transient, and closed the moment its
question is answered.

## Refer by name

Every map and ticket is an issue, so it has a title. In everything the operator
reads, refer to it by that title, never a bare number. `#241, #242, #243` is
illegible; names read at a glance. The link rides inside the name.

## The map

One issue, labelled `wayfinder:map`, no milestone. Its tickets are its native
sub-issues. The map is an **index, not a store**: a decision lives in exactly
one place — its ticket — and the map gists and links, never restates. That is
[`single-owner-facts`](../../../docs/principles/single-owner-facts.md) applied
to the tracker.

Where the destination is an architecture decision — two locked decisions
disagree, or one is about to be made by accident — the `arch-review` template is
the right shape for the map body, and the resolution ends up in the owning doc
under `docs/architecture/`, not on the issue.

### Map body

```markdown
## Destination

<what the end of this map looks like: the spec, the decision, or the change it
is finding its way to. One or two lines; every session orients to it first.>

## Notes

<the area, its owning docs, the skills each session should call, standing
preferences for this effort>

## Decisions so far

- [<closed ticket title>](link): one-line gist of the answer

## Not yet specified

<in-scope fog: questions you can see coming but cannot yet phrase sharply>

## Out of scope

<work ruled beyond the destination; closed, never graduates>
```

Open tickets are **not** listed. They are open sub-issues, and a query finds them.

### Tickets

Each ticket is a sub-issue of the map, body sized to one session:

```markdown
## Question

<the decision or investigation this ticket resolves>
```

Each carries exactly one `wayfinder:<type>` label and the map's `area:*` label.

**Wiring, and the trap in it.** Creating the issue and attaching it are two
steps, and the attach API takes the sub-issue's internal **id**, not its number:

```bash
gh issue create --title "..." --body "..." --label wayfinder:grilling,area:dist
gh api repos/TheVaus/Cubical/issues/<map>/sub_issues -f sub_issue_id=<the id>
```

Read the id back with `gh api repos/TheVaus/Cubical/issues/<n> --jq .id`. Passing
the issue *number* there silently attaches the wrong issue or none at all.

**Blocking** uses this repo's convention, not GitHub's dependency graph: a
`Blocked by #N` line in the body plus the `blocked` label, removed when the
blocker closes. A ticket is **unblocked** when it carries no `blocked` label.

**Claiming**: assign the ticket to the operator before any work, so a concurrent
session skips it. An open, unassigned ticket is unclaimed.

The **frontier** is the open, unassigned sub-issues without the `blocked` label
— the edge of the known.

## Ticket types

Every ticket is **HITL** (worked with the operator, who speaks for themselves)
or **AFK** (the agent alone). A HITL ticket resolves only through that live
exchange; an agent that answers its own grilling questions has broken this.

- **`wayfinder:research`** (AFK) — a fact a decision waits on: an upstream API,
  a platform constraint, what the codebase already does. Dispatch an `explorer`
  ([`subagents.md`](../../../docs/principles/subagents.md)). Its report is a
  claim: verify anything load-bearing before recording it as the answer. The
  explorer does not branch, commit or post — findings come back to you, and you
  post them as the resolution comment.
- **`wayfinder:prototype`** (HITL) — raise the fidelity of the discussion with
  something cheap and concrete to react to. Build it on a branch off `main` like
  any other work, smoke it interactively if it renders, and link the branch or
  PR from the ticket. A prototype is still a session: it commits, pushes and
  opens a PR, and says in the body that it is a spike.
- **`wayfinder:grilling`** (HITL) — conversation. The default case. Call the
  Skill tool for `grilling`.
- **`wayfinder:task`** (either) — manual work that must happen before a decision
  can be made: obtaining a signing certificate, provisioning access, standing up
  a test vault at a size nobody has measured. The one type that *does* rather
  than decides, and it earns that by unblocking a decision. Drive it alone where
  you can; otherwise hand the operator a precise checklist. The answer records
  what was done and any fact later tickets depend on.

## Fog of war

The map is deliberately incomplete: do not chart what you cannot see. Beyond the
live tickets is the fog — decisions you can tell are coming but cannot yet pin
down. **Not yet specified** is where that dim view is written.

**Fog or ticket?** The test is whether you can state the question precisely
*now*, not whether you can answer it now.

- **Ticket** when the question is already sharp, even if blocked.
- **Not yet specified** when you cannot phrase it that sharply. Do not pre-slice
  the fog: one patch may graduate into several tickets, or none.

## Out of scope

Fog gathers only *toward* the destination, so work beyond it is not fog. When a
ticket turns out to sit past the destination, **close it** and leave one line in
**Out of scope**: the gist, why it is out, and a link to the closed ticket. It
stays out of Decisions-so-far, which records the route actually walked.

If the thing ruled out is a capability someone will ask for again, it is also a
scope fact, and [`constraints.md`](../../../docs/architecture/constraints.md)
owns those. Record it there and link; the map's Out-of-scope section is about
*this effort*, not about Cubical.

## Invocation

Two modes. Either way, **never resolve more than one ticket per session**,
research excepted. One surface per session is the cadence this repo already runs.

### Chart the map

The operator invokes with a loose idea.

1. **Name the destination.** Call `grilling` to pin down what this map is
   finding its way to. The destination fixes the scope, so it settles first.
2. **Map the frontier.** Grill again, breadth-first: fan out across the space
   rather than deep on one thread. **If this surfaces no fog** — the way is
   already clear and the whole journey fits one session — you do not need a map.
   Stop and say so; a `feature` issue is the right shape instead.
3. **Create the map** (`wayfinder:map`, the effort's `area:*`, no milestone):
   Destination and Notes filled, Decisions-so-far empty, fog in Not yet specified.
4. **Create the tickets you can specify now**, attach them as sub-issues, then
   wire `Blocked by #N` in a second pass — issues need numbers before they can
   reference each other.
5. **Fire the research explorers** for every `wayfinder:research` ticket, in
   parallel. Verify and post their findings yourself.
6. **Stop.** Charting is one session's work and hand-resolves nothing.

### Work through the map

The operator invokes with a map. A ticket is optional: without one, you pick the
next decision, not the operator.

1. Load the **map** — the low-resolution view, not every ticket body.
2. Choose a ticket: the one named, else the first on the frontier. **Claim it**
   by assigning before any work.
3. Resolve it. Zoom into a related or closed ticket on demand. Call whichever
   skills the Notes block names.
4. Record: post the answer as a resolution comment, close the ticket, append one
   line to the map's Decisions-so-far.
5. Graduate the fog the answer cleared into fresh tickets, clearing each
   graduated patch from Not yet specified. Rule out of scope anything the answer
   pushed past the destination. Update or close tickets the decision invalidated.

A session that edited a doc, a gate or any code along the way still ends
committed, pushed and on an open PR — [`sessions.md`](../../../docs/principles/sessions.md)
binds every session, and charting a map does not exempt one.

## Local edits

Cubical substitutions for upstream's generic tracker: native GitHub dependencies
became the `Blocked by #N` plus `blocked` convention this repo already owns; the
sub-issue attach trap (internal id, not issue number) is written in because it
fails silently; the uninstalled `research` and `domain-modeling` skills became
the `explorer` agent and the architecture docs; a research subagent no longer
takes its own branch, because a subagent here does not commit; `prototype`
became a spike on a real branch under the ordinary session obligations; and the
`idea` label is explicitly excluded, since a wayfinder ticket is transient and an
`idea` is permanent. Preserve these when re-syncing against upstream.
