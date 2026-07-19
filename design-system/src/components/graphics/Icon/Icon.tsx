import type { JSX } from "solid-js";
import { ICONS, type IconName } from "./icons";
import { SVG_INVARIANTS } from "../svg";
import "./Icon.css";

export type { IconName };

export interface IconProps {
  name: IconName;
  size?: number;
  /** When set, the icon is announced (role="img" + aria-label). */
  title?: string;
  ariaLabel?: string;
  class?: string;
  style?: JSX.CSSProperties | string;
}

const Icon = (props: IconProps) => {
  const size = () => props.size ?? 16;
  const label = () => props.ariaLabel ?? props.title;
  return (
    <svg
      class={`ds-icon${props.class ? ` ${props.class}` : ""}`}
      width={size()}
      height={size()}
      viewBox="0 0 24 24"
      stroke-width="2"
      {...SVG_INVARIANTS}
      role={label() ? "img" : undefined}
      aria-label={label() || undefined}
      aria-hidden={label() ? undefined : "true"}
      style={props.style}
      innerHTML={ICONS[props.name]}
    />
  );
};

export default Icon;
