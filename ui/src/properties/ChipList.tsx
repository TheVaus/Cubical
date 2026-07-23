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

export interface ChipListProps {
  value: string[];
  onCommit: (next: string[]) => void;
  allTags?: boolean;
  onChipClick?: (chip: string) => void;
}

function sameArray(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

const ChipList: Component<ChipListProps> = (props) => {
  const [chips, setChips] = createSignal<string[]>([...props.value]);
  const [editing, setEditing] = createSignal(-1);
  const [draft, setDraft] = createSignal("");
  let editInput!: HTMLInputElement;

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
