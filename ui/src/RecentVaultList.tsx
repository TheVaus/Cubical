import { For, Show } from "solid-js";

import type { RecentVault } from "./api/ipc";

/**
 * Shared list of recent vaults, used by the vault-switcher popover and
 * the empty-vault landing. An existing vault is a one-click switch; a
 * missing one (folder deleted/moved/unmounted) is greyed with a × to
 * prune it. Presentational — all persistence flows through the callbacks.
 */
export interface RecentVaultListProps {
  vaults: RecentVault[];
  onSwitch: (path: string) => void;
  onRemove: (path: string) => void;
}

function vaultName(path: string): string {
  return path.split("/").filter(Boolean).pop() ?? path;
}

export function RecentVaultList(props: RecentVaultListProps) {
  return (
    <ul class="recent-vaults">
      <For each={props.vaults}>
        {(v) => (
          <li
            class="recent-vaults__row"
            classList={{ "recent-vaults__row--missing": !v.exists }}
          >
            <Show
              when={v.exists}
              fallback={
                <>
                  <span class="recent-vaults__name" title={v.path}>
                    {vaultName(v.path)}{" "}
                    <span class="recent-vaults__hint">(missing)</span>
                  </span>
                  <button
                    type="button"
                    class="recent-vaults__remove"
                    aria-label={`Remove ${vaultName(v.path)} from recent vaults`}
                    onClick={() => props.onRemove(v.path)}
                  >
                    ×
                  </button>
                </>
              }
            >
              <button
                type="button"
                class="recent-vaults__switch"
                title={v.path}
                onClick={() => props.onSwitch(v.path)}
              >
                {vaultName(v.path)}
              </button>
            </Show>
          </li>
        )}
      </For>
    </ul>
  );
}
