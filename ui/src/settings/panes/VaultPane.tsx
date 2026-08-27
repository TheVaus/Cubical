import { createSignal } from "solid-js";

import Button from "@ds/components/forms/Button/Button";
import ConfirmDialog from "@ds/components/overlay/ConfirmDialog/ConfirmDialog";

import { resetSettings } from "../resetSettings";
import type { SettingsState } from "../settingsState";

const VaultPane = (props: {
  settings: SettingsState;
  vaultPath: string | null;
  busy: boolean;
  onOpenAnother: () => void;
}) => {
  const [confirming, setConfirming] = createSignal(false);

  return (
    <>
      <h2 class="set-h2">Vault</h2>
      <div class="set-row">
        <div class="set-row__text">
          <div class="set-row__lab">Current vault</div>
          <div class="set-row__desc set-row__desc--path">
            {props.vaultPath ?? "—"}
          </div>
        </div>
        <div class="set-row__control">
          <Button
            variant="primary"
            onClick={() => props.onOpenAnother()}
            disabled={props.busy}
          >
            Open another…
          </Button>
        </div>
      </div>

      <div class="set-row">
        <div class="set-row__text">
          <div class="set-row__lab">Reset settings</div>
          <div class="set-row__desc">
            Put every setting for this vault back to its default — appearance,
            editor, wiki links, plugins, status bar, and shortcuts. Your notes
            are not touched, and other vaults keep their own settings.
          </div>
        </div>
        <div class="set-row__control">
          <Button
            variant="danger"
            onClick={() => setConfirming(true)}
            disabled={props.busy}
          >
            Reset…
          </Button>
        </div>
      </div>

      <ConfirmDialog
        open={confirming()}
        title="Reset all settings?"
        confirmLabel="Reset settings"
        tone="danger"
        onCancel={() => setConfirming(false)}
        onConfirm={() => {
          resetSettings(props.settings);
          setConfirming(false);
        }}
      >
        <p>
          Every setting for this vault goes back to its default, including your
          custom shortcuts. This cannot be undone.
        </p>
        <p>No notes are changed, and your other vaults are unaffected.</p>
      </ConfirmDialog>
    </>
  );
};

export default VaultPane;
