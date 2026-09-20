import { For } from "solid-js";

import OnOffControl from "../settings/OnOffControl";
import type { SettingsPaneProps } from "../settings/sections";
import {
  STATUSBAR_ENABLED_KEY,
  registeredStatusbarSegments,
} from "./statusbarSettings";

const StatusbarPane = (props: SettingsPaneProps) => (
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
        value={props.settings.value(STATUSBAR_ENABLED_KEY)}
        onChange={(v) => props.settings.setValue(STATUSBAR_ENABLED_KEY, v)}
      />
    </div>
    <For each={registeredStatusbarSegments()}>
      {(seg) => {
        const on = () => props.settings.value(seg.settingKey);
        return (
          <div
            class="set-row"
            style={{
              opacity: props.settings.value(STATUSBAR_ENABLED_KEY) ? 1 : 0.5,
              "pointer-events": props.settings.value(STATUSBAR_ENABLED_KEY)
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
              onChange={(v) => props.settings.setValue(seg.settingKey, v)}
            />
          </div>
        );
      }}
    </For>
  </>
);

export default StatusbarPane;
