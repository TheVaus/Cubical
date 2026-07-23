import { Show, type JSX } from 'solid-js';

import IconButton from '../../forms/IconButton/IconButton';
import Icon from '../../graphics/Icon/Icon';
import './Tag.css';

export interface TagProps {
  label: string;
  tag?: boolean;
  onClick?: () => void;
  clickTitle?: string;
  onEdit?: (() => void) | undefined;
  onRemove?: () => void;
  removeTitle?: string;
  class?: string;
  style?: JSX.CSSProperties | string;
}

const Tag = (props: TagProps) => {
  return (
    <span
      class={`ds-tag${props.class ? ` ${props.class}` : ''}`}
      classList={{ 'ds-tag--tag': props.tag }}
      style={props.style}
    >
      <Show
        when={props.onClick}
        fallback={<span class="ds-tag__label">{props.label}</span>}
      >
        <button
          type="button"
          class="ds-tag__label"
          title={props.clickTitle}
          aria-label={props.clickTitle}
          onClick={() => props.onClick?.()}
        >
          {props.label}
        </button>
      </Show>
      <Show when={props.onEdit}>
        <IconButton label="edit" size="sm" onClick={() => props.onEdit?.()}>
          <Icon name="edit" />
        </IconButton>
      </Show>
      <Show when={props.onRemove}>
        <IconButton
          label={props.removeTitle ?? `Remove ${props.label}`}
          size="sm"
          onClick={() => props.onRemove?.()}
        >
          <Icon name="close" />
        </IconButton>
      </Show>
    </span>
  );
};

export default Tag;
