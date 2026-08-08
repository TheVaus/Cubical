import { createSignal, type Accessor, type JSX } from "solid-js";

import Icon from "@ds/components/graphics/Icon/Icon";
import Popover from "@ds/components/overlay/Popover/Popover";

import { toggleInfo, type InfoId } from "./settingsInfo";

export interface InfoControl {
  openId: Accessor<InfoId | null>;
  flip: (id: InfoId) => void;
  close: () => void;
}

export function createInfoControl(): InfoControl {
  const [openId, setOpenId] = createSignal<InfoId | null>(null);
  return {
    openId,
    flip: (id) => setOpenId((cur) => toggleInfo(cur, id)),
    close: () => setOpenId(null),
  };
}

export interface InfoButtonProps {
  id: InfoId;
  info: InfoControl;
  children: JSX.Element;
}

const InfoButton = (props: InfoButtonProps) => (
  <>
    <button
      type="button"
      class="set-info-btn"
      aria-label="About this setting"
      aria-expanded={props.info.openId() === props.id}
      onClick={() => props.info.flip(props.id)}
    >
      <Icon name="info" />
    </button>
    <Popover
      open={props.info.openId() === props.id}
      onClose={() => props.info.close()}
      ariaLabel="Setting help"
      placement="bottom-end"
      class="set-info-pop"
    >
      {props.children}
    </Popover>
  </>
);

export default InfoButton;
