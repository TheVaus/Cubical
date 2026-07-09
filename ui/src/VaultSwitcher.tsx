import { For, Show, onCleanup, onMount } from "solid-js";

/**
 * Minimal in-app vault switcher popover (#3). Shows the current vault
 * and an "Open folder…" action that wraps the existing open-vault flow.
 * `recentVaults` is a forward-compatible seam: today it is always empty
 * (no global recent-vaults store yet — deferred to its own session);
 * a future store populates the prop without changing this component.
 */
export interface VaultSwitcherProps {
  currentPath: string | null;
  recentVaults?: { path: string }[];
  onOpenFolder: () => void;
  onDismiss: () => void;
}

function vaultName(path: string): string {
  return path.split("/").filter(Boolean).pop() ?? path;
}

export function VaultSwitcher(props: VaultSwitcherProps) {
  // Dismissal mirrors the info-popover pattern (`.set-info-pop` /
  // `.set-info-backdrop` in App.tsx): a full-viewport transparent backdrop
  // sits below the popover but above the rest of the UI, and its own onClick
  // dismisses. Because the backdrop intercepts the click, a single click can
  // never reach both the backdrop and the trigger button (a sibling of the
  // popover) — which structurally prevents the close-then-reopen race a
  // document-level mousedown listener would cause. Escape-to-dismiss is kept
  // as an extra affordance the info popover lacks.
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") props.onDismiss();
  };
  onMount(() => {
    document.addEventListener("keydown", onKey);
  });
  onCleanup(() => {
    document.removeEventListener("keydown", onKey);
  });

  const recents = () => props.recentVaults ?? [];

  return (
    <>
      <div class="vault-switcher-backdrop" onClick={() => props.onDismiss()} />
      <div class="vault-switcher" role="dialog" aria-label="Switch vault">
        <div class="vault-switcher__current">
          <span class="vault-switcher__label">Current vault</span>
          <span class="vault-switcher__path" title={props.currentPath ?? ""}>
            {props.currentPath ? vaultName(props.currentPath) : "—"}
          </span>
        </div>
        <Show when={recents().length > 0}>
          <ul class="vault-switcher__recents">
            <For each={recents()}>
              {(v) => <li title={v.path}>{vaultName(v.path)}</li>}
            </For>
          </ul>
        </Show>
        <button
          type="button"
          class="vault-switcher__open"
          onClick={() => {
            props.onDismiss();
            props.onOpenFolder();
          }}
        >
          Open folder…
        </button>
      </div>
    </>
  );
}
