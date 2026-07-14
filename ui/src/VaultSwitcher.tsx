import { Show, onCleanup, onMount } from "solid-js";

import Button from "@ds/components/forms/Button/Button";

import { RecentVaultList } from "./RecentVaultList";
import type { RecentVault } from "./api/ipc";

/**
 * In-app vault switcher popover. Shows the current vault, a "Switch to"
 * list of the other recent vaults (one click to switch, × to prune a
 * missing one), and an "Open another vault…" action that wraps the
 * open-vault flow for a vault the app hasn't seen before.
 *
 * The switch list excludes the current vault, so it is empty until a
 * second vault has been opened once. In that state we say so explicitly
 * rather than rendering nothing — otherwise the popover collapses to a
 * lone OS-picker button and reads as broken.
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
        <div class="vault-switcher__section">
          <span class="vault-switcher__label">Switch to</span>
          <Show
            when={recents().length > 0}
            fallback={
              <p class="vault-switcher__empty">
                No other vaults yet. Add one below — after that, switching is a
                single click.
              </p>
            }
          >
            <RecentVaultList
              vaults={recents()}
              onSwitch={(path) => {
                props.onDismiss();
                props.onSwitch(path);
              }}
              onRemove={(path) => props.onRemove(path)}
            />
          </Show>
        </div>
        <Button
          variant="secondary"
          fullWidth
          onClick={() => {
            props.onDismiss();
            props.onOpenFolder();
          }}
        >
          Open another vault…
        </Button>
      </div>
    </>
  );
}
