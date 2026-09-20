import { For } from "solid-js";

import TextInput from "@ds/components/forms/TextInput/TextInput";

import OnOffControl from "../OnOffControl";
import { slotsFor } from "../paneSlots";
import type { SettingsPaneProps } from "../sections";

const EditorPane = (props: SettingsPaneProps) => (
  <>
    <h2 class="set-h2">Editor</h2>
    <div class="set-row">
      <div>
        <div class="set-row__lab">Open notes in raw source by default</div>
        <div class="set-row__desc">Otherwise notes open in Live Preview.</div>
      </div>
      <OnOffControl
        value={props.settings.rawDefault()}
        onChange={props.settings.setRawDefaultValue}
      />
    </div>
    <div class="set-row">
      <div>
        <div class="set-row__lab">Minimap</div>
        <div class="set-row__desc">
          Show a document overview strip beside the editor.
        </div>
      </div>
      <OnOffControl
        value={props.settings.minimapEnabled()}
        onChange={props.settings.setMinimapEnabledValue}
      />
    </div>
    <div class="set-row">
      <div>
        <div class="set-row__lab">Live editor tabs</div>
        <div class="set-row__desc">
          How many open tabs keep a live editor. Tabs beyond this reload from
          disk when you return to them.
        </div>
      </div>
      <TextInput
        class="set-row__num"
        type="number"
        min={1}
        step={1}
        value={String(props.settings.liveTabLimit())}
        onChange={(v) => props.settings.setLiveTabLimitValue(Number(v))}
      />
    </div>
    <div class="set-row">
      <div>
        <div class="set-row__lab">Colorize raw source</div>
        <div class="set-row__desc">
          In Raw Source mode, tint wiki-links, links and tags with rendered-mode
          colors. Nothing is hidden or rendered — only colors change.
        </div>
      </div>
      <OnOffControl
        value={props.settings.colorizeSource()}
        onChange={props.settings.setColorizeSourceValue}
      />
    </div>
    <For each={slotsFor("editor")}>
      {(slot) => <slot.pane settings={props.settings} info={props.info} />}
    </For>
  </>
);

export default EditorPane;
