import { Show, onCleanup, onMount } from "solid-js";

import { RecentVaultList } from "./RecentVaultList";
import type { RecentVault } from "./api/ipc";

/**
 * Minimal in-app vault switcher popover (#3). Shows the current vault,
 * the recent-vaults list (switch or prune), and an "Open folder…" action
 * that wraps the existing open-vault flow.
 */
export interface VaultSwitcherProps {
  currentPath: string | null;
  recentVaults?: RecentVault[];
  onSwitch: (path: string) => void;
  onRemove: (path: string) => void;
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
          <RecentVaultList
            vaults={recents()}
            onSwitch={(path) => {
              props.onDismiss();
              props.onSwitch(path);
            }}
            onRemove={(path) => props.onRemove(path)}
          />
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
