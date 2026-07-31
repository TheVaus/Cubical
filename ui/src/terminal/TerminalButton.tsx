import { Show, type JSXElement } from "solid-js";

import IconButton from "@ds/components/forms/IconButton/IconButton";
import Icon from "@ds/components/graphics/Icon/Icon";

import type { TabView } from "../tabs/tabModel";
import { TERMINAL_COMMAND_TITLE } from "./registration";
import { isTerminalView } from "./tabView";

export function TerminalButton(props: {
  available: () => boolean;
  onOpen: () => void;
  view: () => TabView;
}): JSXElement {
  const active = () => isTerminalView(props.view());
  return (
    <Show when={props.available()}>
      <IconButton
        label={TERMINAL_COMMAND_TITLE}
        onClick={props.onOpen}
        active={active()}
        ariaPressed={active()}
      >
        <Icon name="terminal" />
      </IconButton>
    </Show>
  );
}
