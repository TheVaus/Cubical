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

import { chipStyle } from "./styles";

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
 * Judgement call (design-system migration Task 4): the chip pill itself
 * (the `<span style={chipStyle(...)}>`) is kept bespoke rather than `@ds
 * Tag`. `Tag` renders a single `<button class="tag">#{label}</button>` —
 * one interactive element, a hardcoded `#` prefix, and no way to host a
 * second affordance inside it. Every chip here needs a *second*
 * interactive control alongside the label (always a `×` remove button;
 * navigable tag chips also get a separate `✎` edit button), and plain
 * (non-tag) chips must never gain a `#` at all. Swapping the label for
 * `Tag` would either force the `#` onto plain chips (explicitly
 * disallowed) or require the remove/edit glyphs to live outside `Tag`'s
 * own pill as separate floating buttons — visually splitting one chip
 * into two adjacent pills, a real layout regression, not a small delta.
 * `chipStyle` keeps serving both chip kinds as the pill container; every
 * button *inside* the pill (label, `✎`, `×`, `+ add`) now runs through
 * `@ds IconButton size="sm"`, using its `style` escape hatch (added this
 * task) to reproduce the label's color/font/padding inherit-from-chip
 * look — the one behavioral delta is a hover background now appearing
 * behind the label text, which the outgoing plain `<button>` never had.
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
                <span style={chipStyle(tag())}>
                  <IconButton
                    label={display()}
                    title={navigable() ? `Open ${display()}` : "Edit"}
                    size="sm"
                    style={{
                      color: "inherit",
                      "font-family": "inherit",
                      "font-size": "inherit",
                      padding: "0",
                    }}
                    onClick={() =>
                      navigable()
                        ? props.onChipClick!(chip.replace(/^#/, ""))
                        : startEdit(i())
                    }
                  >
                    {display()}
                  </IconButton>
                  <Show when={navigable()}>
                    <IconButton
                      label={`Edit ${chip}`}
                      title="Edit"
                      size="sm"
                      onClick={() => startEdit(i())}
                    >
                      ✎
                    </IconButton>
                  </Show>
                  <IconButton
                    label={`Remove ${chip}`}
                    size="sm"
                    onClick={() => removeChip(i())}
                  >
                    ×
                  </IconButton>
                </span>
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
