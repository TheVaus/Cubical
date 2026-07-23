import type { JSX } from 'solid-js';
import { Show } from 'solid-js';
import './Link.css';

export interface LinkProps {
  children: JSX.Element;
  href?: string;
  onClick?: () => void;
  size?: 'xs' | 'sm' | 'md';
  ariaLabel?: string;
  class?: string;
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
