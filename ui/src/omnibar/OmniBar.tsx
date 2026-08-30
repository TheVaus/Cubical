import {
  createEffect,
  createMemo,
  createSignal,
  For,
  on,
  Show,
  type Component,
} from "solid-js";
import { rankItems, matchText, type OmniItem, type RankedItem } from "./ranker";
import Icon from "@ds/components/graphics/Icon/Icon";

const RESULT_LIMIT = 50;

export interface OmniBarProps {
  open: boolean;
  items: OmniItem[];
  recentNotes: RankedItem[];
  onClose: () => void;
  onOpenNote: (path: string) => void;
  onOpenTag: (tag: string) => void;
  onRunCommand: (id: string) => void;
}

const OmniBar: Component<OmniBarProps> = (props) => {
  const [query, setQuery] = createSignal("");
  const [selected, setSelected] = createSignal(0);
  let inputEl: HTMLInputElement | undefined;
  let restoreFocusTo: HTMLElement | null = null;

  const results = createMemo<RankedItem[]>(() =>
    query().trim() === ""
      ? props.recentNotes
      : rankItems(query(), props.items, RESULT_LIMIT),
  );

  createEffect(
    on(
      () => props.open,
      (open) => {
        if (open) {
          restoreFocusTo = document.activeElement as HTMLElement | null;
          setQuery("");
          setSelected(0);
          queueMicrotask(() => inputEl?.focus());
        } else {
          restoreFocusTo?.focus?.();
        }
      },
    ),
  );

  createEffect(
    on(results, (r) => {
      if (selected() >= r.length) setSelected(0);
    }),
  );

  const activate = (r: RankedItem | undefined) => {
    if (!r) return;
    if (r.item.kind === "note") props.onOpenNote(r.item.path);
    else if (r.item.kind === "tag") props.onOpenTag(r.item.tag);
    else props.onRunCommand(r.item.id);
    props.onClose();
  };

  const onKey = (e: KeyboardEvent) => {
    const r = results();
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelected((s) => Math.min(s + 1, r.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelected((s) => Math.max(s - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      activate(r[selected()]);
    } else if (e.key === "Escape") {
      e.preventDefault();
      props.onClose();
    }
  };

  return (
    <Show when={props.open}>
      <div
        role="presentation"
        onClick={props.onClose}
        style={{
          position: "fixed",
          inset: 0,
          display: "flex",
          "align-items": "flex-start",
          "justify-content": "center",
          "padding-top": "12vh",
          background: "var(--scrim)",
          "z-index": 30,
        }}
      >
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Quick switcher"
          onClick={(e) => e.stopPropagation()}
          onKeyDown={onKey}
          style={{
            width: "min(40rem, 90vw)",
            "max-height": "70vh",
            display: "flex",
            "flex-direction": "column",
            background: "var(--c-bg-primary)",
            border: "1px solid var(--c-border-subtle)",
            "border-radius": "var(--radius-md)",
            "box-shadow": "var(--shadow-lg)",
            overflow: "hidden",
          }}
        >
          <input
            ref={inputEl}
            type="text"
            value={query()}
            placeholder="Jump to a note or tag…"
            aria-label="Search notes and tags"
            aria-activedescendant={
              results()[selected()] ? `omni-opt-${selected()}` : undefined
            }
            onInput={(e) => {
              setQuery(e.currentTarget.value);
              setSelected(0);
            }}
            style={{
              "box-sizing": "border-box",
              margin: "var(--space-3)",
              padding: "var(--space-2) var(--space-3)",
              "font-size": "var(--text-md, var(--text-sm))",
              color: "var(--c-fg-primary)",
              background: "var(--c-bg-secondary)",
              border: "1px solid var(--c-border-subtle)",
              "border-radius": "var(--radius-sm, var(--radius-md))",
            }}
          />
          <div
            role="listbox"
            aria-label="Results"
            style={{ "min-height": 0, "overflow-y": "auto", "min-width": 0 }}
          >
            <Show
              when={results().length > 0}
              fallback={
                <div
                  style={{
                    padding: "var(--space-3)",
                    color: "var(--c-fg-muted)",
                    "font-size": "var(--text-sm)",
                  }}
                >
                  {props.items.length === 0
                    ? "No notes yet"
                    : "No notes or tags match"}
                </div>
              }
            >
              <For each={results()}>
                {(r, i) => (
                  <OmniRow
                    id={`omni-opt-${i()}`}
                    ranked={r}
                    selected={i() === selected()}
                    onHover={() => setSelected(i())}
                    onClick={() => activate(r)}
                  />
                )}
              </For>
            </Show>
          </div>
        </div>
      </div>
    </Show>
  );
};

const OmniRow: Component<{
  id: string;
  ranked: RankedItem;
  selected: boolean;
  onHover: () => void;
  onClick: () => void;
}> = (props) => {
  const text = () => matchText(props.ranked.item);
  const marks = () => new Set(props.ranked.matchedIndices);
  return (
    <div
      id={props.id}
      role="option"
      aria-selected={props.selected}
      onMouseMove={props.onHover}
      onClick={props.onClick}
      style={{
        display: "flex",
        "align-items": "center",
        gap: "var(--space-2)",
        "min-width": 0,
        padding: "var(--space-2) var(--space-3)",
        cursor: "pointer",
        background: props.selected ? "var(--c-bg-secondary)" : "transparent",
        "border-left": props.selected
          ? "2px solid var(--c-accent)"
          : "2px solid transparent",
      }}
    >
      <span
        style={{
          "flex-shrink": 0,
          width: "1.5rem",
          "text-align": "center",
          color: "var(--c-fg-muted)",
          "font-size": "var(--text-xs)",
        }}
      >
        <Icon
          name={
            props.ranked.item.kind === "tag"
              ? "hash"
              : props.ranked.item.kind === "command"
                ? "command"
                : "file-text"
          }
          size={13}
        />
      </span>
      <span
        style={{
          "min-width": 0,
          display: "flex",
          "flex-direction": "column",
          overflow: "hidden",
        }}
      >
        <span
          style={{
            "font-size": "var(--text-sm)",
            color: "var(--c-fg-primary)",
            overflow: "hidden",
            "text-overflow": "ellipsis",
            "white-space": "nowrap",
          }}
        >
          <For each={[...text()]}>
            {(ch, i) =>
              marks().has(i()) ? (
                <mark
                  style={{
                    background: "transparent",
                    color: "var(--c-accent)",
                    "font-weight": 600,
                  }}
                >
                  {ch}
                </mark>
              ) : (
                <span>{ch}</span>
              )
            }
          </For>
        </span>
        <Show when={props.ranked.item.kind === "note"}>
          <span
            style={{
              "font-size": "var(--text-xs)",
              color: "var(--c-fg-muted)",
              "font-family": "var(--font-mono)",
              overflow: "hidden",
              "text-overflow": "ellipsis",
              "white-space": "nowrap",
            }}
          >
            {(props.ranked.item as { path: string }).path}
          </span>
        </Show>
      </span>
    </div>
  );
};

export default OmniBar;
