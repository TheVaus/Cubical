import { For } from "solid-js";

import {
  STATUSBAR_ENABLED_KEY,
  STATUSBAR_SEGMENTS,
} from "../../statusbar/segments";
import OnOffControl from "../OnOffControl";
import type { SettingsState } from "../settingsState";

const StatusbarPane = (props: { settings: SettingsState }) => (
  <>
    <h2 class="set-h2">Status bar</h2>
    <div class="set-row">
      <div>
        <div class="set-row__lab">Show status bar</div>
        <div class="set-row__desc">
          The bar along the bottom. When off, it disappears entirely.
        </div>
      </div>
      <OnOffControl
        value={props.settings.statusbarEnabled()}
        onChange={(v) =>
          props.settings.setStatusbarSetting(STATUSBAR_ENABLED_KEY, v)
        }
      />
    </div>
    <For each={STATUSBAR_SEGMENTS}>
      {(seg) => {
        const on = () => props.settings.segVisible(seg);
        return (
          <div
            class="set-row"
            style={{
              opacity: props.settings.statusbarEnabled() ? 1 : 0.5,
              "pointer-events": props.settings.statusbarEnabled()
                ? "auto"
                : "none",
            }}
          >
            <div>
              <div class="set-row__lab">{seg.name}</div>
              <div class="set-row__desc">{seg.description}</div>
            </div>
            <OnOffControl
              value={on()}
              onChange={(v) =>
                props.settings.setStatusbarSetting(seg.settingKey, v)
              }
            />
          </div>
        );
      }}
    </For>
  </>
);

export default StatusbarPane;
