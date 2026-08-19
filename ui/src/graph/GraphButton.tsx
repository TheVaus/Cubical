import { Show, type JSXElement } from "solid-js";

import IconButton from "@ds/components/forms/IconButton/IconButton";
import Icon from "@ds/components/graphics/Icon/Icon";

import type { TabView } from "../tabs/tabModel";
import { GRAPH_COMMAND_TITLE } from "./registration";
import { isGraphView } from "./tabView";

export function GraphButton(props: {
  available: () => boolean;
  onOpen: () => void;
  view: () => TabView;
}): JSXElement {
  const active = () => isGraphView(props.view());
  return (
    <Show when={props.available()}>
      <IconButton
        label={GRAPH_COMMAND_TITLE}
        onClick={props.onOpen}
        active={active()}
        ariaPressed={active()}
      >
        <Icon name="waypoints" />
      </IconButton>
    </Show>
  );
}
