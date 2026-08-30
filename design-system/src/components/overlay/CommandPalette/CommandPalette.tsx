import { createEffect, createMemo, createSignal, createUniqueId, For, on, Show } from 'solid-js';
import Modal from '../Modal/Modal';
import TextInput from '../../forms/TextInput/TextInput';
import Icon, { type IconName } from '../../graphics/Icon/Icon';
import './CommandPalette.css';

export interface Command {
  id: string;
  label: string;
  onRun: () => void;
}

export interface CommandPaletteItem {
  id: string;
  label: string;
  detail?: string | undefined;
  icon?: IconName | undefined;
  matchedIndices?: number[] | undefined;
  onRun: () => void;
}

export interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  commands?: Command[] | undefined;
  items?: CommandPaletteItem[] | undefined;
  query?: string | undefined;
  onQueryInput?: ((value: string) => void) | undefined;
  placeholder?: string | undefined;
  emptyLabel?: string | undefined;
  ariaLabel?: string | undefined;
  inputAriaLabel?: string | undefined;
  listAriaLabel?: string | undefined;
  selectedIndex?: number | undefined;
  onSelectedIndexChange?: ((index: number) => void) | undefined;
  autoFocus?: boolean | undefined;
}

const MatchedLabel = (props: { text: string; indices?: number[] | undefined }) => {
  const chars = createMemo(() => [...props.text]);
  const marks = createMemo(() => new Set(props.indices ?? []));
  return (
    <Show when={(props.indices?.length ?? 0) > 0} fallback={props.text}>
      <For each={chars()}>
        {(ch, i) =>
          marks().has(i()) ? <mark class="command-item__mark">{ch}</mark> : <span>{ch}</span>
        }
      </For>
    </Show>
  );
};

const CommandPalette = (props: CommandPaletteProps) => {
  const [internalQuery, setInternalQuery] = createSignal('');
  const optionPrefix = createUniqueId();
  let inputEl: HTMLInputElement | undefined;
  let listEl: HTMLDivElement | undefined;
  let restoreFocusTo: HTMLElement | null = null;

  const modalLabel = () => (props.ariaLabel === undefined ? {} : { ariaLabel: props.ariaLabel });
  const inputLabel = () =>
    props.inputAriaLabel === undefined ? {} : { ariaLabel: props.inputAriaLabel };
  const controlledQuery = () => props.query !== undefined;
  const query = () => props.query ?? internalQuery();
  const selectable = () => props.selectedIndex !== undefined;
  const selectedIndex = () => props.selectedIndex ?? 0;

  const rows = createMemo<CommandPaletteItem[]>(() => {
    const rich = props.items;
    if (rich) return rich;
    const q = query().toLowerCase();
    return (props.commands ?? [])
      .filter((c) => c.label.toLowerCase().includes(q))
      .map((c) => ({ id: c.id, label: c.label, onRun: c.onRun }));
  });

  const optionId = (index: number) => `${optionPrefix}-opt-${index}`;
  const activeOptionId = () =>
    selectable() && rows()[selectedIndex()] ? optionId(selectedIndex()) : undefined;

  const setQuery = (value: string) => {
    if (!controlledQuery()) setInternalQuery(value);
    props.onQueryInput?.(value);
  };

  const run = (item: CommandPaletteItem) => {
    item.onRun();
    if (!controlledQuery()) setInternalQuery('');
    props.onClose();
  };

  const select = (index: number) => {
    if (selectable() && index !== selectedIndex()) props.onSelectedIndexChange?.(index);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (!selectable()) return;
    const list = rows();
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      props.onSelectedIndexChange?.(Math.min(selectedIndex() + 1, list.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      props.onSelectedIndexChange?.(Math.max(selectedIndex() - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const item = list[selectedIndex()];
      if (item) run(item);
    }
  };

  createEffect(
    on(
      () => props.open,
      (open) => {
        if (!props.autoFocus) return;
        if (open) {
          restoreFocusTo = document.activeElement as HTMLElement | null;
          queueMicrotask(() => inputEl?.focus());
        } else {
          restoreFocusTo?.focus?.();
          restoreFocusTo = null;
        }
      },
    ),
  );

  createEffect(() => {
    const id = activeOptionId();
    if (!inputEl) return;
    if (id) inputEl.setAttribute('aria-activedescendant', id);
    else inputEl.removeAttribute('aria-activedescendant');
  });

  createEffect(() => {
    const index = selectedIndex();
    if (!selectable() || !props.open || rows().length === 0) return;
    const el = listEl?.children[index] as HTMLElement | undefined;
    el?.scrollIntoView?.({ block: 'nearest' });
  });

  return (
    <Modal open={props.open} onClose={props.onClose} {...modalLabel()}>
      <div class="command-palette">
        <TextInput
          ref={(el) => (inputEl = el)}
          value={query()}
          onInput={setQuery}
          onKeyDown={onKeyDown}
          placeholder={props.placeholder ?? 'Type a command…'}
          {...inputLabel()}
        />
        <div
          class="command-list"
          ref={listEl}
          role={selectable() ? 'listbox' : undefined}
          aria-label={props.listAriaLabel}
        >
          <Show
            when={rows().length > 0}
            fallback={
              <div class="command-empty">{props.emptyLabel ?? 'No matching commands.'}</div>
            }
          >
            <For each={rows()}>
              {(item, i) => (
                <button
                  type="button"
                  id={optionId(i())}
                  class="command-item"
                  classList={{ 'is-selected': selectable() && i() === selectedIndex() }}
                  role={selectable() ? 'option' : undefined}
                  aria-selected={selectable() ? i() === selectedIndex() : undefined}
                  tabindex={selectable() ? -1 : undefined}
                  onMouseMove={() => select(i())}
                  onClick={() => run(item)}
                >
                  <Show when={item.icon}>
                    {(name) => (
                      <span class="command-item__icon">
                        <Icon name={name()} size={13} />
                      </span>
                    )}
                  </Show>
                  <span class="command-item__text">
                    <span class="command-item__label">
                      <MatchedLabel text={item.label} indices={item.matchedIndices} />
                    </span>
                    <Show when={item.detail}>
                      <span class="command-item__detail">{item.detail}</span>
                    </Show>
                  </span>
                </button>
              )}
            </For>
          </Show>
        </div>
      </div>
    </Modal>
  );
};

export default CommandPalette;
