import { createSignal, For, Show } from "solid-js";
import { Dynamic } from "solid-js/web";

import IconButton from "@ds/components/forms/IconButton/IconButton";
import Icon from "@ds/components/graphics/Icon/Icon";

import {
  CORE_PLUGINS,
  corePluginEnabled,
  missingRequirements,
  type PluginDocId,
} from "../corePlugins";
import { PLUGIN_DOCS } from "../docs";
import OnOffControl from "../OnOffControl";
import type { SettingsState } from "../settingsState";

const PluginsPane = (props: { settings: SettingsState }) => {
  const [docId, setDocId] = createSignal<PluginDocId | null>(null);
  const doc = () => {
    const id = docId();
    return id === null ? null : PLUGIN_DOCS[id];
  };

  return (
    <Show
      when={doc()}
      fallback={
        <>
          <h2 class="set-h2">Core Plugins</h2>
          <For each={CORE_PLUGINS}>
            {(p) => (
              <div class="set-row">
                <div class="set-row__text">
                  <div class="set-row__lab">{p.name}</div>
                  <div class="set-row__desc">{p.description}</div>
                  <Show
                    when={
                      missingRequirements(props.settings.corePlugins(), p)[0]
                    }
                  >
                    {(blocker) => (
                      <div class="set-row__desc set-row__desc--blocked">
                        Inactive: needs {blocker().name}, which is off.
                      </div>
                    )}
                  </Show>
                </div>
                <div class="set-row__control">
                  <Show when={p.docId}>
                    {(id) => (
                      <IconButton
                        label={`How ${p.name} works`}
                        size="sm"
                        onClick={() => setDocId(id())}
                      >
                        <Icon name="info" />
                      </IconButton>
                    )}
                  </Show>
                  <OnOffControl
                    value={corePluginEnabled(props.settings.corePlugins(), p)}
                    onChange={(v) =>
                      props.settings.setCorePlugin(p.id, p.settingKey, v)
                    }
                  />
                </div>
              </div>
            )}
          </For>
        </>
      }
    >
      {(active) => (
        <>
          <div class="set-doc__head">
            <IconButton
              label="Back to plugins"
              size="sm"
              onClick={() => setDocId(null)}
            >
              <Icon name="chevron-right" class="set-doc__back" />
            </IconButton>
          </div>
          <h2 class="set-h2">{active().title}</h2>
          <div class="set-doc">
            <Dynamic component={active().body} />
          </div>
        </>
      )}
    </Show>
  );
};

export default PluginsPane;
