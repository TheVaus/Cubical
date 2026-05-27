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
 * Shared chip-row primitive behind `StringListCell` and `TagListCell`
 * (L2 Session F, spec §2.4). Renders a string array as removable chips
 * with click-to-edit text and a trailing `+` add affordance.
 *
 * `isTag` switches the chip presentation to the tag style (`#` prefix,
 * accent color). It does *not* change storage — the committed array
 * always holds bare strings.
 *
 * While any chip is being edited, incoming `value` prop changes are
 * ignored so an `onAstChange` refresh cannot clobber the edit
 * (brainstorming decision (d)).
 */
export interface ChipListProps {
  value: string[];
  isTag: boolean;
  onCommit: (next: string[]) => void;
  /**
   * Optional click handler invoked when the chip body is clicked. When
   * supplied, the chip body becomes a navigation gesture (used by the
   * L3 Session E tag chip → tag-page wiring) and editing moves to a
   * dedicated `✎` button shown beside `×`. When omitted, the chip body
   * starts an inline edit (the original L2 Session F behaviour).
   */
  onChipClick?: (chip: string) => void;
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
        {(chip, i) => (
          <Show
            when={editing() === i()}
            fallback={
              <span style={chipStyle(props.isTag)}>
                <button
                  type="button"
                  onClick={() =>
                    props.onChipClick
                      ? props.onChipClick(chip)
                      : startEdit(i())
                  }
                  title={props.onChipClick ? `Open #${chip}` : "Edit"}
                  style={{
                    ...miniButtonStyle(),
                    color: "inherit",
                    "font-family": "inherit",
                    "font-size": "inherit",
                    padding: "0",
                  }}
                >
                  {props.isTag ? `#${chip}` : chip}
                </button>
                <Show when={props.onChipClick}>
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
                "font-family": props.isTag
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
        )}
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
