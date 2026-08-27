import { createSignal, For, Show } from "solid-js";
import { Dynamic } from "solid-js/web";

import Button from "@ds/components/forms/Button/Button";
import Icon from "@ds/components/graphics/Icon/Icon";

import { CORE_PLUGINS, type PluginDocId } from "../corePlugins";
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
                  <Show when={p.docId}>
                    {(id) => (
                      <div class="set-row__more">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setDocId(id())}
                        >
                          How it works
                        </Button>
                      </div>
                    )}
                  </Show>
                </div>
                <div class="set-row__control">
                  <OnOffControl
                    value={props.settings.corePlugins()[p.id] ?? p.defaultEnabled}
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
            <Button variant="ghost" size="sm" onClick={() => setDocId(null)}>
              <Icon name="chevron-right" size={14} class="set-doc__back" />
              Plugins
            </Button>
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
