# L3 Session G follow-up — broken block-ref status-bar indicator (design)

**Date:** 2026-05-29
**Layer:** 3 — Knowledge Graph
**Depends on:** Session G backend core (spec §9.8) — `get_broken_block_refs` command + the `getBrokenBlockRefs` / `BrokenBlockRef` IPC bindings already in `ui/src/api/ipc.ts` (currently unused).

## Goal

Surface broken block references in the UI: a passive indicator in the existing footer status bar showing how many `[[note#^id]]` references point at a block id that no longer exists, with a tooltip listing them. Closes the visible half of Session G's vault-health story.

Frontend-only — no backend changes.

## Scope

**In:** a footer indicator driven by `getBrokenBlockRefs`, refreshed on scan-complete and on vault file changes; a pure formatting helper.

**Out (deferred / YAGNI):**
- Broken **wiki-link** surfacing — no backend query or IPC exists for it; the §9.8 note about surfacing "alongside broken wiki-links" stays aspirational until that lands.
- Click-to-navigate from the indicator, or a dedicated broken-refs panel. The indicator is passive display only.
- `[[#^` in-bracket autocomplete (its own session).

## Background — relevant existing machinery

- **The status-bar shell already exists.** `App.tsx` renders a `<footer>` (~line 1345): a flex `space-between` row with a left `<span>` (scan status: `Scanning… / N files / cancelled`) and a right `<span>` (`vaultId()`). No new shell is needed — the indicator joins this footer.
- **IPC is ready.** `ui/src/api/ipc.ts` exports `getBrokenBlockRefs(req): Promise<GetBrokenBlockRefsResponse>` with `BrokenBlockRef { source_file_path, target_file_path, target_block_id }` and `GetBrokenBlockRefsResponse { refs }`. Backend orders them stably.
- **Refresh hooks.** `App.tsx` already reacts to `vault:file-changed` (`onVaultFileChanged`, ~line 626) with debounced refreshes (`scheduleRefresh` for the file list, `scheduleBacklinksRefresh` for backlinks) and to `onVaultScanComplete` (~line 615). Vault open/reset clears per-vault signals (e.g. `wikilinkResolver`, `setFiles([])`).
- **Warning styling precedent.** The unresolved-wikilink decoration uses `var(--c-warning, var(--c-accent))` (decorations.ts) — reuse it for the indicator.

## Component / data flow

```
vault open / scan-complete ─┐
vault:file-changed (debounced) ─┼─> refreshBrokenBlockRefs()
                                │      └─ getBrokenBlockRefs({vault_id})
                                │           └─ setBrokenBlockRefs(resp.refs)
vault reset ────────────────────┘  (clears to [])

footer render: formatBrokenBlockRefs(brokenBlockRefs())
   → null            → render nothing
   → { label, title} → render warning <span title={title}>{label}</span>
```

### State + refresh (`App.tsx`)

- New signal `const [brokenBlockRefs, setBrokenBlockRefs] = createSignal<BrokenBlockRef[]>([])`.
- `refreshBrokenBlockRefs()`: read `vaultId()`; if null, no-op. Else `await getBrokenBlockRefs({ vault_id: id })`, then `setBrokenBlockRefs(resp.refs)`; on error, `console.error` and leave the prior value.
- A debounced trigger `scheduleBrokenBlockRefsRefresh()` mirroring `scheduleBacklinksRefresh` (a ~200ms debounce so a burst of `vault:file-changed` events collapses into one query).
- Wire-up:
  - In `onVaultScanComplete` handler: call `void refreshBrokenBlockRefs()` (the index is complete).
  - In `onVaultFileChanged` handler: call `scheduleBrokenBlockRefsRefresh()` (any edit can create/heal a broken ref).
  - On the vault reset/open path that clears the other per-vault signals: `setBrokenBlockRefs([])`.

### Formatting helper (pure, tested)

New module `ui/src/statusbar/brokenRefs.ts`:

```ts
import type { BrokenBlockRef } from "../api/ipc";

export interface BrokenRefsDisplay {
  /** Footer label, e.g. "⚠ 2 broken block refs". */
  label: string;
  /** Tooltip: one "source → target#^id" line per ref. */
  title: string;
}

/** Footer display for broken block refs, or null when there are none. */
export function formatBrokenBlockRefs(
  refs: BrokenBlockRef[],
): BrokenRefsDisplay | null {
  if (refs.length === 0) return null;
  const noun = refs.length === 1 ? "broken block ref" : "broken block refs";
  const label = `⚠ ${refs.length} ${noun}`;
  const title = refs
    .map(
      (r) => `${r.source_file_path} → ${r.target_file_path}#^${r.target_block_id}`,
    )
    .join("\n");
  return { label, title };
}
```

### Render (`App.tsx` footer)

Inside the `<footer>`, between the scan-status span and the `vaultId` span, render the indicator only when the helper returns non-null:

```tsx
<Show when={formatBrokenBlockRefs(brokenBlockRefs())}>
  {(display) => (
    <span
      title={display().title}
      style={{ color: "var(--c-warning, var(--c-accent))" }}
    >
      {display().label}
    </span>
  )}
</Show>
```

(The footer stays a flex row; with three children the middle indicator sits between scan status and vault id. Acceptable — it only appears when there's something to report.)

## Error handling

- IPC failure in `refreshBrokenBlockRefs` is logged and swallowed; the indicator keeps its last value rather than flickering to zero on a transient error.
- No vault open → no-op (and the signal is `[]`, so nothing renders).

## Testing

- **Unit (vitest):** `formatBrokenBlockRefs` — empty → null; one → singular label; many → plural label + count; tooltip lines formatted `source → target#^id`.
- **Glue:** the signal/refresh/render wiring is thin; covered by the hands-on smoke (the native Tauri window can't be browser-driven in this automated context).
- **Gates:** `npx tsc --noEmit`, `npx vitest run`, `npm run build`; Rust suite unchanged.

## Smoke plan (hands-on)

In `cargo tauri dev`: create `[[note#^missing]]` in one note (target lacks `^missing`); confirm the footer shows `⚠ 1 broken block ref` with a tooltip; add `^missing` to the target (or via the copy gesture) and confirm the indicator disappears after the file-change refresh.

## Follow-ups (unchanged)

- `[[#^` in-bracket block-id autocomplete (needs a backend ids-in-file query).
- Broken wiki-link surfacing (needs a backend query/IPC) — would then share this footer indicator.
- Session H — Embeds.
