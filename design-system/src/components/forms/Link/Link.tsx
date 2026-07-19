import type { JSX } from 'solid-js';
import { Show } from 'solid-js';
import './Link.css';

export interface LinkProps {
  children: JSX.Element;
  /** Present → renders `<a href>`; absent → renders `<button type="button">` (action-link). */
  href?: string;
  onClick?: () => void;
  /** Font size. Defaults to 'sm'. */
  size?: 'xs' | 'sm' | 'md';
  ariaLabel?: string;
  class?: string;
  /** Escape hatch for instance-specific layout overrides (token-driven values only). */
  style?: JSX.CSSProperties | string;
}

const Link = (props: LinkProps) => {
  const classes = () =>
    `ds-link ds-link--${props.size ?? 'sm'}${props.class ? ` ${props.class}` : ''}`;

  return (
    <Show
      when={props.href}
      fallback={
        <button
          type="button"
          class={classes()}
          aria-label={props.ariaLabel}
          style={props.style}
          onClick={() => props.onClick?.()}
        >
          {props.children}
        </button>
      }
    >
      <a
        href={props.href}
        class={classes()}
        aria-label={props.ariaLabel}
        style={props.style}
      >
        {props.children}
      </a>
    </Show>
  );
};

export default Link;
