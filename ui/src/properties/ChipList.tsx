import {
  createEffect,
  createSignal,
  For,
  on,
  Show,
  type Component,
} from "solid-js";

import IconButton from "@ds/components/forms/IconButton/IconButton";
import TextInput from "@ds/components/forms/TextInput/TextInput";
import Tag from "@ds/components/data/Tag/Tag";

/**
 * Shared chip-row primitive behind `StringListCell` (spec §4.4). Renders
 * a string array as removable chips with click-to-edit text and a
 * trailing `+` add affordance.
 *
 * Tag styling is **per item**: a chip whose stored string starts with `#`
 * renders accent-colored (mono). The `#` is part of the stored value, not
 * added by the renderer. When `onChipClick` is supplied, clicking a
 * `#`-chip navigates (the `#` is stripped for the lookup) and editing
 * moves to a `✎` button; plain chips always click-to-edit.
 *
 * While any chip is being edited, incoming `value` prop changes are
 * ignored so an `onAstChange` refresh cannot clobber the edit.
 *
 * The non-editing chip pill is the `@ds Tag` component (Task S4) — it
 * hosts the label plus optional edit/remove affordances in one pill.
 */
export interface ChipListProps {
  value: string[];
  onCommit: (next: string[]) => void;
  /**
   * When true, every item is a tag chip regardless of a `#` prefix (the
   * special `tags` property). Items without a `#` are shown with one
   * (display only — the stored value is unchanged).
   */
  allTags?: boolean;
  /** Optional navigation handler for tag chips (tag pages). */
  onChipClick?: (chip: string) => void;
}

function sameArray(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

const ChipList: Component<ChipListProps> = (props) => {
  const [chips, setChips] = createSignal<string[]>([...props.value]);
  const [editing, setEditing] = createSignal(-1);
  const [draft, setDraft] = createSignal("");
  // Shared across chip rows: only one chip can be `editing()` at a time,
  // so a single ref var (set on mount of whichever row is in edit mode)
  // is enough — same pattern as the single-input cells (StringCell etc).
  let editInput!: HTMLInputElement;

  // Adopt external value changes only — must NOT re-run on `editing`
  // alone, or blurring a chip edit would revert the local chips to
  // stale props during the 150ms AST-tick window.
  createEffect(
    on(
      () => props.value,
      (v) => {
        if (editing() < 0) setChips([...v]);
      },
    ),
  );

  const commitArray = (next: string[]) => {
    setChips(next);
    if (!sameArray(next, props.value)) props.onCommit(next);
  };

  const startEdit = (i: number) => {
    setDraft(chips()[i] ?? "");
    setEditing(i);
  };

  const commitEdit = () => {
    const i = editing();
    if (i < 0) return;
    const text = draft().trim();
    const next = [...chips()];
    if (text === "") {
      next.splice(i, 1);
    } else {
      next[i] = text;
    }
    setEditing(-1);
    commitArray(next);
  };

  const removeChip = (i: number) => {
    commitArray(chips().filter((_, idx) => idx !== i));
  };

  const addChip = () => {
    const next = [...chips(), ""];
    setChips(next);
    setDraft("");
    setEditing(next.length - 1);
  };

  return (
    <div
      style={{
        display: "flex",
        "flex-wrap": "wrap",
        "align-items": "center",
        gap: "var(--space-1)",
        padding: "var(--space-1) 0",
      }}
    >
      <For each={chips()}>
        {(chip, i) => {
          const tag = () => (props.allTags ?? false) || chip.startsWith("#");
          const navigable = () => tag() && props.onChipClick !== undefined;
          // Display a leading `#` for a tags-property item that lacks one;
          // the stored value stays bare.
          const display = () =>
            tag() && !chip.startsWith("#") ? `#${chip}` : chip;
          return (
            <Show
              when={editing() === i()}
              fallback={
                <Tag
                  label={display()}
                  tag={tag()}
                  onClick={() =>
                    navigable() ? props.onChipClick!(chip.replace(/^#/, "")) : startEdit(i())
                  }
                  clickTitle={navigable() ? `Open ${display()}` : "Edit"}
                  onEdit={navigable() ? () => startEdit(i()) : undefined}
                  onRemove={() => removeChip(i())}
                  removeTitle={`Remove ${chip}`}
                />
              }
            >
              <TextInput
                ref={(el) => {
                  editInput = el;
                  queueMicrotask(() => el.focus());
                }}
                size="sm"
                value={draft()}
                onInput={setDraft}
                onBlur={commitEdit}
                onKeyDown={(e) => {
                  if (e.key === "Enter") editInput.blur();
                }}
                style={{
                  width: "auto",
                  "font-family": tag()
                    ? "var(--font-mono)"
                    : "var(--font-body)",
                }}
              />
            </Show>
          );
        }}
      </For>
      <IconButton
        label="Add item"
        size="sm"
        onClick={addChip}
        style={{ color: "var(--c-accent)" }}
      >
        + add
      </IconButton>
    </div>
  );
};

export default ChipList;
