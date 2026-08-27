import { createSignal } from "solid-js";

import ConfirmDialog from "@ds/components/overlay/ConfirmDialog/ConfirmDialog";

import OnOffControl from "../OnOffControl";
import type { SettingsState } from "../settingsState";

const WikilinksPane = (props: { settings: SettingsState }) => {
  const [confirming, setConfirming] = createSignal(false);

  const change = (value: boolean) => {
    if (value) {
      props.settings.setRewriteBrokenLinksValue(true);
      return;
    }
    setConfirming(true);
  };

  return (
    <>
      <h2 class="set-h2">Wiki links</h2>
      <div class="set-row">
        <div class="set-row__text">
          <div class="set-row__lab">Repair broken links on rename</div>
          <div class="set-row__desc">
            When you rename a file, also fix links that point at its old name
            but had already broken — from an earlier rename, or from a name
            typed before the note existed. Off, a rename only updates links that
            still resolve to the file.
          </div>
        </div>
        <div class="set-row__control">
          <OnOffControl
            value={props.settings.rewriteBrokenLinks()}
            onChange={change}
          />
        </div>
      </div>

      <ConfirmDialog
        open={confirming()}
        title="Stop repairing broken links?"
        confirmLabel="Turn off"
        cancelLabel="Keep it on"
        tone="danger"
        onCancel={() => setConfirming(false)}
        onConfirm={() => {
          props.settings.setRewriteBrokenLinksValue(false);
          setConfirming(false);
        }}
      >
        <p>
          With this off, renaming a note leaves already-broken links pointing at
          the old name. They stay broken, and each later rename can add more.
        </p>
        <p>
          Leave it on unless you deliberately want a rename to touch nothing but
          links that currently resolve.
        </p>
      </ConfirmDialog>
    </>
  );
};

export default WikilinksPane;
