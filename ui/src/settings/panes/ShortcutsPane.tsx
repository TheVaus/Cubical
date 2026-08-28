import InfoButton, { type InfoControl } from "../InfoButton";
import ShortcutsPanel from "../ShortcutsPanel";
import type { SettingsState } from "../settingsState";

const ShortcutsPane = (props: {
  settings: SettingsState;
  info: InfoControl;
}) => (
  <>
    <div
      class="set-row__control"
      style={{
        "justify-content": "flex-end",
        "margin-bottom": "var(--space-2)",
      }}
    >
      <InfoButton id="shortcuts" info={props.info}>
        <p>
          Click the pencil on any row, then press the key combination you
          want. Escape cancels; a combo already used in the same scope is
          rejected. <strong>Reset</strong> appears once a row differs from its
          default. New in this release: follow the link under the
          cursor (Alt+Enter), toggle the left sidebar (⌘/Ctrl+Shift+L), new note
          (⌘/Ctrl+N), and navigate back/forward (⌘/Ctrl+Alt+←/→).
        </p>
      </InfoButton>
    </div>
    <ShortcutsPanel
      overrides={props.settings.shortcutOverrides()}
      onChange={props.settings.setShortcutOverridesValue}
    />
  </>
);

export default ShortcutsPane;
