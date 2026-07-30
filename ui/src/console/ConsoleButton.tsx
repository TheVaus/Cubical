import { Show, type JSXElement } from "solid-js";

import IconButton from "@ds/components/forms/IconButton/IconButton";
import Icon from "@ds/components/graphics/Icon/Icon";

import type { TabView } from "../tabs/tabModel";
import { CONSOLE_COMMAND_TITLE } from "./registration";
import { isConsoleView } from "./tabView";

export function ConsoleButton(props: {
  available: () => boolean;
  onOpen: () => void;
  view: () => TabView;
}): JSXElement {
  const active = () => isConsoleView(props.view());
  return (
    <Show when={props.available()}>
      <IconButton
        label={CONSOLE_COMMAND_TITLE}
        onClick={props.onOpen}
        active={active()}
        ariaPressed={active()}
      >
        <Icon name="terminal" />
      </IconButton>
    </Show>
  );
}
