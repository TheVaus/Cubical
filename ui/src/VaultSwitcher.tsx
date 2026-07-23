import { Show } from "solid-js";

import Button from "@ds/components/forms/Button/Button";
import Popover from "@ds/components/overlay/Popover/Popover";

import { RecentVaultList } from "./RecentVaultList";
import type { RecentVault } from "./api/ipc";

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
  const recents = () => props.recentVaults ?? [];

  return (
    <Popover
      open={true}
      onClose={props.onDismiss}
      ariaLabel="Switch vault"
      placement="top-start"
      class="vault-switcher"
    >
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
    </Popover>
  );
}
