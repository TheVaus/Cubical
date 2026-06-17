import {
  createEffect,
  createSignal,
  For,
  on,
  Show,
  type Component,
} from "solid-js";

import { chipStyle, miniButtonStyle } from "./styles";

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
 */
export interface ChipListProps {
  value: string[];
  onCommit: (next: string[]) => void;
  /** Optional navigation handler for `#`-prefixed chips (tag pages). */
  onChipClick?: (chip: string) => void;
}

/** A chip renders as a tag when its stored value starts with `#`. */
function isTagChip(chip: string): boolean {
  return chip.startsWith("#");
}

function sameArray(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

const ChipList: Component<ChipListProps> = (props) => {
  const [chips, setChips] = createSignal<string[]>([...props.value]);
  const [editing, setEditing] = createSignal(-1);
  const [draft, setDraft] = createSignal("");

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
          const tag = () => isTagChip(chip);
          const navigable = () => tag() && props.onChipClick !== undefined;
          return (
            <Show
              when={editing() === i()}
              fallback={
                <span style={chipStyle(tag())}>
                  <button
                    type="button"
                    onClick={() =>
                      navigable()
                        ? props.onChipClick!(chip.replace(/^#/, ""))
                        : startEdit(i())
                    }
                    title={navigable() ? `Open ${chip}` : "Edit"}
                    style={{
                      ...miniButtonStyle(),
                      color: "inherit",
                      "font-family": "inherit",
                      "font-size": "inherit",
                      padding: "0",
                    }}
                  >
                    {chip}
                  </button>
                  <Show when={navigable()}>
                    <button
                      type="button"
                      onClick={() => startEdit(i())}
                      aria-label={`Edit ${chip}`}
                      title="Edit"
                      style={miniButtonStyle()}
                    >
                      ✎
                    </button>
                  </Show>
                  <button
                    type="button"
                    onClick={() => removeChip(i())}
                    aria-label={`Remove ${chip}`}
                    style={miniButtonStyle()}
                  >
                    ×
                  </button>
                </span>
              }
            >
              <input
                type="text"
                value={draft()}
                ref={(el) => queueMicrotask(() => el.focus())}
                onInput={(e) => setDraft(e.currentTarget.value)}
                onBlur={commitEdit}
                onKeyDown={(e) => {
                  if (e.key === "Enter") e.currentTarget.blur();
                }}
                style={{
                  width: "7rem",
                  padding: "0 var(--space-2)",
                  height: "1.5rem",
                  "font-family": tag()
                    ? "var(--font-mono)"
                    : "var(--font-body)",
                  "font-size": "var(--text-xs)",
                  color: "var(--c-fg-primary)",
                  background: "var(--c-bg-primary)",
                  border: "1px solid var(--c-accent)",
                  "border-radius": "var(--radius-full)",
                  outline: "none",
                }}
              />
            </Show>
          );
        }}
      </For>
      <button
        type="button"
        onClick={addChip}
        style={{ ...miniButtonStyle(), color: "var(--c-accent)" }}
      >
        + add
      </button>
    </div>
  );
};

export default ChipList;
