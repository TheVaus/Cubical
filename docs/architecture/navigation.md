> Locked decisions. Architecture review required to change. Index: [docs/architecture/README.md](README.md)
>
> *Covers §15 (navigation). Layout, Live Preview and settings are §11–§12 in [`ui.md`](ui.md); the tab data model's implementation invariants are owned by [`../implementation/frontend.md`](../implementation/frontend.md) → Tabs.*

# Cubical — Architecture: Navigation

## 15. Navigation

This file answers one question: *when the user causes a document to appear, what
happens to the tab set and to history?* It does not restate the `TabSet`
invariants (keep-alive editors, flush-on-activate, persistence, LRU exclusion) —
those are owned by [`../implementation/frontend.md`](../implementation/frontend.md)
→ Tabs.

Code is cited by **symbol name**, never `path:line` — the rule and the rot that
motivated it are owned by
[`../principles/implementation-anchors.md`](../principles/implementation-anchors.md).
A path is given, without a line, only where it helps locate a symbol. Each
subsection carries an `**Anchors:**` line, checked against the tracked source by
`scripts/gates/symbol_anchors.py`.

### 15.1 One tab per view — there is no replace mode

**Anchors:** tabId · openTab · createTerminalWiring · maybeInterceptWikiLinkMousedown · maybeInterceptTagMousedown · maybeInterceptDataviewMousedown

Tab identity is **derived from the view, never minted** (`tabId`,
`tabs/tabModel.ts`): `file:<path>`, `tag:<tagPath>`, `terminal:<key>`.
`openTab` is therefore idempotent — a tab whose id already exists is merely
activated, otherwise one is appended and activated.

That single fact is the whole answer to "new tab or replace?":

- **Every document navigation is open-or-focus.** Nothing replaces a tab's
  content; nothing opens a second tab on the same document.
- There is **no preview/pinned tab concept**, no "open in new tab" gesture, no
  middle-click, no split. The active tab is never reused for a different
  document.
- The only view that can exist twice is the terminal, because its key is a
  monotonic counter rather than a document identity (the `open` closure in
  `createTerminalWiring`).

Why keep it: deriving identity from the view deletes all tab bookkeeping — no id
allocator, no "which tab holds this path" map — and makes rename a pure key
remap. The cost is paid in history (§15.4), which cannot be per-tab as a result.

**Modifier keys are deliberately not a navigation channel.** Every editor click
interceptor bails on any modifier and on any non-primary button
(`maybeInterceptWikiLinkMousedown`; identical shape in
`maybeInterceptTagMousedown` and `maybeInterceptDataviewMousedown`), handing the
event back to CodeMirror so Mod-click and Shift-click keep their normal
text-selection meaning inside a text editor. An "open in new tab" gesture
therefore cannot be a modifier click without taking selection semantics away
from the editor — that trade has not been made.

### 15.2 Entry points

Every row below ends in one of the three dispatchers of §15.3. "Open-or-focus"
means the §15.1 semantics.

**Anchors:** handleSelectFile · handleNavigateWikilink · handleNavigateTag · handleExitTagView · handleRunCommand · handleClickAtPos · createPathForTarget · createFileAtPath · createFile · activateTabById · closeTabById · moveTab · goBack · goForward · openTab · restoreTabs · remapTabPaths · dropMissingTabs

| Entry point | Emitted by | Routes through | Result |
|---|---|---|---|
| File-tree row click | left file panel | `handleSelectFile` | Open-or-focus. A non-markdown row opens a read-only viewer when its extension has one (§15.5); rows with no viewer stay inert |
| Wikilink click in Live Preview | `Editor.tsx` → `handleClickAtPos` → `createPathForTarget` (`editor/wikilinkClick.ts`) | `handleNavigateWikilink` | Resolved → open-or-focus (+ anchor, §15.3). Unresolved → **no navigation**; raises the create-offer dialog instead |
| Follow link under cursor (`Alt-Enter`) | `core/commands.ts`, `Editor.tsx` | same as above | Identical to the click; it reuses `handleClickAtPos` at the cursor |
| Embed (`![[…]]`) | — | — | **Not a navigation entry point.** The embed widget has no click handler and no `data-path` (`editor/embed.ts`, `editor/embedRender.ts`); a click just places the caret. Embeds render content in place, they do not go anywhere |
| Tag click in the editor | `Editor.tsx` | `handleNavigateTag` | Open-or-focus a `tag` tab |
| Tag chip in the Properties table | `Properties.tsx` | `handleNavigateTag` | Same |
| Backlink row | `sidebar/Backlinks.tsx` | `handleNavigateWikilink(path, null)` | Open-or-focus, no anchor |
| Unlinked-mention row | `sidebar/UnlinkedMentions.tsx` | same | Same |
| Integrity-panel row | `sidebar/IntegrityPanel.tsx` | same | Same |
| Tag-page file row | `TagPage.tsx` | same | Same |
| Tag-page Back button | `TagPage.tsx` | `handleExitTagView` | Activates the tab named by the *current history entry*, then closes the tag tab. If there is no such open tab it just closes the tag tab |
| Search-panel result | `sidebar/SearchPanel.tsx` | `handleNavigateWikilink(path, null)` | Opens the **file**, not the hit. Results are grouped per file and the group header is the only open affordance; there is no jump-to-match |
| Omni-Bar note result | `omnibar/OmniBar.tsx` | `handleNavigateWikilink(path, null)` | Open-or-focus, then the bar closes |
| Omni-Bar tag result | `omnibar/OmniBar.tsx` | `handleNavigateTag` | Tag tab |
| Omni-Bar command result | `omnibar/OmniBar.tsx` | `handleRunCommand` | Not navigation — the omni-bar command set is one entry (`omnibar/commands.ts`), separate from the keymap registry |
| Dataview result link | `Editor.tsx` → the runner's `open` | `handleNavigateWikilink(path, null)` | Open-or-focus |
| Create from unresolved link | the create-offer dialog | `createFileAtPath` then `handleNavigateWikilink` | Creates the file, then opens it. The fresh content hash is threaded through so the watcher's created-echo is not read as an external edit |
| New note (`Mod-N`, the `+` button) | left file panel, keymap | `createFile` then `handleNavigateWikilink` | Same shape |
| Tab-strip click | `tabs/TabStrip.tsx` | `activateTabById` | Focus. Also pushes history when the target is a file tab |
| Tab-strip close / drag | `tabs/TabStrip.tsx` | `closeTabById` / `moveTab` | Close picks the tab at the same index, else the one before (`closeTab`, `tabs/tabModel.ts`). Reorder never changes the active tab |
| `Mod-Tab` / `Mod-Shift-Tab` / `Mod-Shift-W` | keymap | `activateTabById` / `closeTabById` | Cyclic; wraps at both ends |
| Back / forward (`Mod-Alt-←/→`, topbar arrows) | keymap, topbar | `goBack` / `goForward` | §15.4 |
| Open terminal (`Mod-Shift-T`, topbar button) | keymap, topbar | `openTab` directly, via `createTerminalWiring` | **Always a new tab** |
| Vault open / switch / recent-vault pick | `VaultSwitcher.tsx`, `RecentVaultList.tsx` | `openVaultByPath` → `restoreTabs` | Tab set is cleared to empty, then the machine-local session is restored. Missing files are dropped only once the scan is `complete` |
| External rename (watcher or in-app) | the rename handler | `remapTabPaths` | Tab ids follow the path; the active tab stays active |
| External delete | the tab-set effect | `dropMissingTabs` | Falls back to the first surviving tab, gated on scan-complete so a partial file list cannot evict a live tab |

**There is no reveal-in-tree.** The tree marks the active file's row selected
but never scrolls it into view, and the list is virtualized — so
after navigating from a backlink or the omni-bar, the active file's row usually
is not rendered at all. Deliberate or not, it is untested and unstated anywhere
else.

### 15.3 Dispatch mechanics

**Anchors:** handleSelectFile · activateTabById · handleNavigateWikilink · handleNavigateTag · activateWithFlush · flushAutosave · resetDocState · openTab · loadActiveTabContent · requestAnchorScroll · scrollToHeading · scrollToBlock · createTerminalWiring

Three functions write `activeId`. Everything in §15.2 funnels into one of them.

**`handleSelectFile(file, knownHash?, { fromHistory }?)`**
is the only path that opens a *file*. Fixed order: reject anything that is neither
markdown nor viewer-backed → bail if it is already the active tab →
`flushAutosave` → `resetDocState` → `openTab` → push history → **return here for
a viewer file** → seed both hashes → `loadActiveTabContent`.

A viewer file takes the same tab, the same history and the same rename remapping
as a note; it simply stops before the editor machinery. See §15.5.

The "already active" bail in `handleSelectFile` is load-bearing in three places:
re-clicking the open note never re-reads from disk, never pushes a duplicate
history entry, and lets anchor navigation to the *current* note take a different
branch (below).

**`activateTabById(id, { fromHistory }?)`** is the only path
that focuses an *already-open* tab by id. It delegates the ordering to
`activateWithFlush` (`tabs/activation.ts`) and then pushes history if the
landing tab is a file tab.

**`handleNavigateWikilink(path, anchor, knownHash?)`** is
a thin wrapper over `handleSelectFile`, and is what every link-shaped entry point
actually calls. It adds two things:

- It **synthesizes a `FileEntry`** when `files()` has no row for the path,
  so navigation does not have to wait for a file-list
  refresh after a create or rename.
- It **splits anchor handling by whether the note is already open**.
  Same note: navigate first (a no-op), then scroll
  synchronously via `scrollToHeading` / `scrollToBlock`, toasting when the
  anchor is missing. Different note: queue the scroll via `requestAnchorScroll`
  *before* switching, because the target editor replaces its buffer through a
  deferred effect and a synchronous scroll would race the load. That queueing is
  currently aimed at the wrong editor — see §15.6.

**Divergences from the funnel.** `handleNavigateTag` and
the terminal's `open` closure in `createTerminalWiring` both call
`setTabs(openTab(…))` directly after a flush, bypassing both dispatchers. They
are safe on the data-loss axis — the tab they switch to has no editor buffer, and
the flush still happens first — but they skip `resetDocState`, so the outgoing
file's `error`, `rawOverride`, `seenHash` and `lastWrittenHash` survive until a
file tab is activated again. `handleSelectFile` likewise reproduces the
activation order inline rather than calling `activateWithFlush`. This is a
partial exception to the "exactly one tested place" rule stated in
[`../implementation/frontend.md`](../implementation/frontend.md) → Tabs; the
ordering is duplicated, not violated, and any new tab-switching path should go
through `tabs/activation.ts` rather than adding a fourth copy.

### 15.4 History

**Anchors:** NavState · navPush · navBack · navForward · navCurrent · setNavState · handleSelectFile · activateTabById · navigateToHistoryPath · handleExitTagView

History is **one global `NavState`**, a pure
list-with-a-cursor over *file paths* (`navHistory.ts`). It is global rather than
per-tab because dedupe-by-identity makes a tab *be* a document — a per-tab stack
could only ever hold the one path that created it. That rationale is owned by
[`../implementation/frontend.md`](../implementation/frontend.md) → Tabs.

- **Pushes:** `handleSelectFile` unless `fromHistory`, and
  `activateTabById` when the switch lands on a file tab —
  so tab-strip clicks and `Mod-Tab` are history events too.
- **Does not push:** tag tabs, terminal tabs, back/forward navigation itself,
  re-selecting the already-active file, and any push whose path equals the
  current entry (`navPush`).
- **Branching** is the browser rule: pushing after going back truncates the
  forward entries (`navPush`).
- **Back/forward** move the cursor (`navBack` / `navForward`), then re-enter
  `handleSelectFile` with `fromHistory: true` through `navigateToHistoryPath`.
  Because that helper synthesizes a `FileEntry` when the path is unknown, back
  **reopens a tab that was closed** rather than skipping the entry.
- **Not persisted.** A restored session starts with empty history.

**History and the active tab can legitimately disagree.** Since tag and terminal
tabs never push, pressing Back from a tag tab does not return to the last file —
it goes to the entry *before* it. `handleExitTagView` is
the workaround: it reads `navCurrent()` directly to find the file tab to restore,
activates it with `fromHistory: true`, and only then closes the tag tab. Any
future non-file tab kind inherits the same asymmetry.

### 15.5 Non-document tabs

**Anchors:** TabView · isPersistableTab · isTerminalView · createTerminalWiring · confirmClose · closeTabById · forceCloseTabById · hasViewer · viewerKindForPath · handleSelectFile · loadActiveTabContent · read_file_bytes · read_file_text

`TabView` has exactly three variants (`tabs/tabModel.ts`). Two of them are
not documents.

**Tag pages** — `{ kind: "tag", tagPath }`. Singleton per tag path by id
derivation, persisted across restarts (`isPersistableTab` allow-lists `file` and
`tag`), and rendered in place of the editor by the `view().kind === "file"`
fallback in the editor layer. They hold no buffer, so they are inert for autosave.
They are absent from nav history (§15.4).

**Terminals** — `{ kind: "terminal", key }`. The one **non-singleton** kind:
`open` increments a counter, so `Mod-Shift-T` always yields another tab. They are
excluded from session persistence and from the keep-alive LRU by allow-list, so a
terminal can never evict a warm editor — rules owned by
[`../implementation/frontend.md`](../implementation/frontend.md) → Tabs. They
render in a separate `<For>` outside the editor tree while
`<Show when={!isTerminalView(view())}>` hides the entire
editor/tag region, which is why a terminal tab has no interaction with the
document write path at all.

Two terminal-specific effects on the tab set:

- **Close is gated on the PTY.** `closeTabById` asks
  `confirmClose` (`terminal/wiring.ts`) whether a child process is
  running, and only `forceCloseTabById` skips the prompt.
  Every non-terminal close path goes through the gate too; it short-circuits when
  the tab has no registered session.
- **Disabling the plugin closes the tabs.** Turning off `plugins.terminal_enabled`
  force-closes every terminal tab and reaps the sessions
  (`createTerminalWiring`) — the default-off gateway rule from
  [`foundation.md`](foundation.md) §2.1 applied to the tab set.

For the terminal's product decisions (why interception is not attempted, what the
gateway rule requires) see [`foundation.md`](foundation.md) §2.1–§2.2.

**Viewer files** — a fourth non-document surface that deliberately introduces
**no** `TabView` variant. A `.png` or `.csv` occupies an ordinary
`{ kind: "file", path }` tab, so it inherits tab persistence, rename remapping
and nav history for free; only the *rendering* differs. One predicate,
`hasViewer(path)` (`viewer/viewerKind.ts`), gates all three divergences:

- `handleSelectFile` admits the file but returns before seeding hashes or
  calling `loadActiveTabContent` (§15.3).
- `loadActiveTabContent` returns early, so `read_file_text` — which rejects
  non-markdown at the engine — is never called for one.
- `live()` excludes it from the keep-alive LRU, so an image tab cannot evict a
  warm editor, matching the terminal rule above.

The viewer fetches its own bytes through `read_file_bytes` and owns its size
caps. Markdown never satisfies `hasViewer`, so the editor keeps sole ownership of
`.md`. Which extensions have viewers, and the byte and row caps, are owned by
`viewer/viewerKind.ts`; formats without one are tracked as
[issues labelled `area:viewers`](https://github.com/TheVaus/Cubical/labels/area%3Aviewers).

### 15.6 Known defects and open questions

**Anchors:** handleNavigateWikilink · requestAnchorScroll · editorApi · openVaultByPath · setNavState · navigateToHistoryPath · resetDocState · handleSelectFile · closestWikiLinkSpan · buildFor

Recorded here rather than fixed, so a session touching navigation starts with
them visible.

1. **Cross-note anchor scroll is queued on the wrong editor.**
   `handleNavigateWikilink` calls `editorApi()?.requestAnchorScroll(anchor)`
   *before* switching tabs, but `editorApi()` resolves
   against the currently active tab and `pendingAnchor` is
   per-`Editor`-instance, drained on that instance's own
   value change. With one shared editor this was
   correct; with keep-alive per-tab editors the anchor lands on the *outgoing*
   editor. Expected symptoms: `[[note#Heading]]` to a different note opens the
   note but does not scroll, and the stale request can fire later against the
   source tab, emitting a spurious "not found" toast. No test covers the
   cross-note case.
2. **Nav history is not cleared on a vault switch.** `openVaultByPath` resets
   tabs, contents, MRU and a dozen other signals but never
   touches `navState` — `setNavState` has no call site in that path. After
   switching vaults, Back can target a path from the previous vault;
   `navigateToHistoryPath` will synthesize an entry for it, open a tab, and fail
   the read with an error banner.
3. **Tag and terminal activation skip `resetDocState`** (§15.3). Not known to
   cause a user-visible fault, because the stale fields are only read while a
   file tab is active, but it is an invariant hole rather than a decision.
4. **Wikilink to a non-markdown target — partly resolved.** `handleSelectFile`
   no longer silently returns for every non-markdown entry: a target whose
   extension has a viewer (§15.5) now opens in one. A target with no viewer —
   `.pdf`, `.docx`, a bare `LICENSE` — still returns silently, so the dead-click
   remains for those. Whether link resolution can ever *return* such a target
   was still not determined from the frontend alone.
5. **Open question — search results do not jump to the match.** The panel groups
   hits per file and opens the file only (`sidebar/SearchPanel.tsx`). Nothing
   in the code or the specs says whether jump-to-hit was cut or simply never
   built.

**On the open `[[wikilink]]` non-render bug** (tracked in the primer): it is a
Live Preview decoration defect, not a navigation one. Bracket-hiding does not
depend on link resolution — the resolver only chooses between the resolved and
unresolved *mark class* (`editor/decorations.ts`) — so an unresolved or
still-fetching link still renders. The navigation-visible consequence is
downstream: a link left in raw form has no `.cm-md-wikilink` span, so
`closestWikiLinkSpan` (`editor/wikilinkMousedown.ts`) finds nothing,
nothing calls `preventDefault`, and the click falls through to ordinary text
selection. Anyone investigating should look at syntax-tree availability
(`buildFor` iterates whatever `syntaxTree(state)` has parsed, and CodeMirror
parses incrementally under a time budget), not at the resolver.
