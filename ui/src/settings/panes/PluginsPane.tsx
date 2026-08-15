import { For, Show } from "solid-js";

import { CORE_PLUGINS } from "../corePlugins";
import InfoButton, { type InfoControl } from "../InfoButton";
import OnOffControl from "../OnOffControl";
import type { SettingsState } from "../settingsState";

const PluginsPane = (props: { settings: SettingsState; info: InfoControl }) => (
  <>
    <h2 class="set-h2">Core Plugins</h2>
    <For each={CORE_PLUGINS}>
      {(p) => {
        const on = () => props.settings.corePlugins()[p.id] ?? p.defaultEnabled;
        return (
          <div class="set-row">
            <div>
              <div class="set-row__lab">{p.name}</div>
              <div class="set-row__desc">{p.description}</div>
            </div>
            <div class="set-row__control">
              <Show when={p.id === "dataview"}>
                <InfoButton id="dataview" info={props.info}>
                  <p>
                    A <code>query</code> block renders live results from your
                    vault as a table, list, or count — it updates as notes
                    change.
                  </p>
                  <pre>
                    {'```query\nfrom #project where status = "active"\n```'}
                  </pre>
                </InfoButton>
              </Show>
              <Show when={p.id === "property-refs"}>
                <InfoButton id="property-refs" info={props.info}>
                  <p>
                    <code>[[note.prop]]</code> shows a value from another note's
                    frontmatter inline; <code>[[.prop]]</code> reads the current
                    note's own.
                  </p>
                  <pre>
                    {
                      "# In Ann.md\n---\nrole: Engineer\n---\n\n# In any note\nAnn is a [[Ann.role]]."
                    }
                  </pre>
                </InfoButton>
              </Show>
              <OnOffControl
                value={on()}
                onChange={(v) =>
                  props.settings.setCorePlugin(p.id, p.settingKey, v)
                }
              />
            </div>
          </div>
        );
      }}
    </For>
  </>
);

export default PluginsPane;
