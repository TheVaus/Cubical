import { createSignal, For, Show } from "solid-js";

import TwoPaneModal from "@ds/components/overlay/TwoPaneModal/TwoPaneModal";

import { createInfoControl } from "./InfoButton";
import AppearancePane from "./panes/AppearancePane";
import EditorPane from "./panes/EditorPane";
import PluginsPane from "./panes/PluginsPane";
import ShortcutsPane from "./panes/ShortcutsPane";
import VaultPane from "./panes/VaultPane";
import WikilinksPane from "./panes/WikilinksPane";
import { registeredSettingsSections } from "./sections";
import type { SettingsState } from "./settingsState";
import { settingsNav } from "./tabs";

export interface SettingsModalProps {
  open: boolean;
  onClose: () => void;
  settings: SettingsState;
  vaultPath: string | null;
  busy: boolean;
  onOpenAnotherVault: () => void;
}

const SettingsModal = (props: SettingsModalProps) => {
  const [tab, setTab] = createSignal<string>("appearance");
  const info = createInfoControl();

  const select = (id: string) => {
    setTab(id);
    info.close();
  };

  return (
    <TwoPaneModal
      open={props.open}
      onClose={() => {
        props.onClose();
        info.close();
      }}
      title="Settings"
      items={settingsNav()}
      activeId={tab()}
      onSelect={(id) => select(id)}
    >
      <Show when={tab() === "appearance"}>
        <AppearancePane settings={props.settings} />
      </Show>
      <Show when={tab() === "editor"}>
        <EditorPane settings={props.settings} info={info} />
      </Show>
      <Show when={tab() === "wikilinks"}>
        <WikilinksPane settings={props.settings} />
      </Show>
      <Show when={tab() === "plugins"}>
        <PluginsPane settings={props.settings} />
      </Show>
      <Show when={tab() === "vault"}>
        <VaultPane
          settings={props.settings}
          vaultPath={props.vaultPath}
          busy={props.busy}
          onOpenAnother={() => props.onOpenAnotherVault()}
        />
      </Show>
      <Show when={tab() === "shortcuts"}>
        <ShortcutsPane settings={props.settings} info={info} />
      </Show>
      <For each={registeredSettingsSections()}>
        {(section) => (
          <Show when={tab() === section.id}>
            <section.pane settings={props.settings} info={info} />
          </Show>
        )}
      </For>
    </TwoPaneModal>
  );
};

export default SettingsModal;
