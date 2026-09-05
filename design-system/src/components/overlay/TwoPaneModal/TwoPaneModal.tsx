import { createEffect, For, onCleanup, Show, type JSX } from 'solid-js';
import { Portal } from 'solid-js/web';
import Icon, { type IconName } from '../../graphics/Icon/Icon';
import IconButton from '../../forms/IconButton/IconButton';
import './TwoPaneModal.css';

export interface TwoPaneNavItem {
  id: string;
  icon?: IconName;
  label: string;
}

export interface TwoPaneModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  items: TwoPaneNavItem[];
  activeId: string;
  onSelect: (id: string) => void;
  ariaLabel?: string;
  children: JSX.Element;
}

const TwoPaneModal = (props: TwoPaneModalProps) => {
  const handleKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') props.onClose();
  };

  createEffect(() => {
    if (!props.open) return;
    document.addEventListener('keydown', handleKey);
    onCleanup(() => document.removeEventListener('keydown', handleKey));
  });

  return (
    <Show when={props.open}>
      <Portal>
        <div
          class="ds-two-pane-modal__scrim"
          data-ds-overlay="modal"
          onClick={() => props.onClose()}
        >
          <div
            class="ds-two-pane-modal__panel"
            role="dialog"
            aria-modal="true"
            aria-label={props.ariaLabel ?? props.title}
            onClick={(e) => e.stopPropagation()}
          >
            <span class="ds-two-pane-modal__close">
              <IconButton label={`Close ${props.title.toLowerCase()}`} onClick={() => props.onClose()}>
                <Icon name="close" />
              </IconButton>
            </span>
            <nav class="ds-two-pane-modal__nav">
              <h3 class="ds-two-pane-modal__navtitle">{props.title}</h3>
              <For each={props.items}>
                {(item) => (
                  <button
                    type="button"
                    class="ds-two-pane-modal__navitem"
                    classList={{
                      'ds-two-pane-modal__navitem--active': props.activeId === item.id,
                    }}
                    aria-current={props.activeId === item.id ? 'true' : undefined}
                    onClick={() => props.onSelect(item.id)}
                  >
                    <Show when={item.icon}>{(name) => <Icon name={name()} size={16} />}</Show>
                    {item.label}
                  </button>
                )}
              </For>
            </nav>
            <div class="ds-two-pane-modal__body">{props.children}</div>
          </div>
        </div>
      </Portal>
    </Show>
  );
};

export default TwoPaneModal;
