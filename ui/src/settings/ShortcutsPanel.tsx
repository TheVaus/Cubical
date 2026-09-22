import {
  type Component,
  createEffect,
  createMemo,
  createSignal,
  For,
  onCleanup,
  Show,
} from "solid-js";

import Button from "@ds/components/forms/Button/Button";
import Icon from "@ds/components/graphics/Icon/Icon";
import IconButton from "@ds/components/forms/IconButton/IconButton";

import {
  registeredCommands,
  resolveBindings,
  type BindingDefault,
} from "../core/commandRegistry";
import {
  eventToChord,
  findConflict,
  formatChordForDisplay,
  specFromChord,
  type CommandScope,
} from "../core/commands";

const MODIFIER_KEYS = new Set(["Meta", "Control", "Shift", "Alt", "AltGraph"]);

export interface ShortcutsPanelProps {
  overrides: Record<string, string>;
  commands?: readonly BindingDefault[];
  onChange: (next: Record<string, string>) => void;
}

const ShortcutsPanel: Component<ShortcutsPanelProps> = (props) => {
  const [listeningId, setListeningId] = createSignal<string | null>(null);
  const [errorFor, setErrorFor] = createSignal<{ id: string; message: string } | null>(
    null,
  );

  const rows = () => props.commands ?? registeredCommands();
  const everyBinding = createMemo(() =>
    resolveBindings(props.overrides, registeredCommands()),
  );
  const keys = createMemo(
    () => new Map(everyBinding().map((b) => [b.command, b.key])),
  );
  const keyFor = (id: string) => keys().get(id) ?? "";
  const titleOf = (id: string) => {
    const title = registeredCommands().find((c) => c.id === id)?.title ?? id;
    return rows().some((c) => c.id === id) ? title : `${title} (switched off)`;
  };

  const startListening = (id: string) => {
    setListeningId(id);
    setErrorFor(null);
  };

  createEffect(() => {
    const id = listeningId();
    if (id === null) return;
    const target = registeredCommands().find((c) => c.id === id);
    if (!target) return;
    const scope: CommandScope = target.scope;

    const handler = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (MODIFIER_KEYS.has(e.key)) return;
      const bare = !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;
      if (bare && e.key === "Escape") {
        setListeningId(null);
        return;
      }
      if (bare) {
        setErrorFor({ id, message: "Shortcuts need a modifier key" });
        return;
      }
      const spec = specFromChord(eventToChord(e));
      const conflictWith = findConflict(spec, scope, everyBinding(), id);
      if (conflictWith) {
        setErrorFor({
          id,
          message: `Already used by ${titleOf(conflictWith)}`,
        });
        return;
      }
      props.onChange({ ...props.overrides, [id]: spec });
      setListeningId(null);
      setErrorFor(null);
    };

    window.addEventListener("keydown", handler, { capture: true });
    onCleanup(() =>
      window.removeEventListener("keydown", handler, { capture: true }),
    );
  });

  const resetRow = (id: string) => {
    const next = { ...props.overrides };
    delete next[id];
    props.onChange(next);
  };

  return (
    <>
      <h2 class="set-h2">Shortcuts</h2>
      <For each={rows()}>
        {(c) => (
          <div class="kb-row">
            <span>{c.title}</span>
            <Show
              when={listeningId() === c.id}
              fallback={
                <Show when={keyFor(c.id)} fallback={<span>Not set</span>}>
                  {(key) => (
                    <For each={formatChordForDisplay(key())}>
                      {(label) => <kbd>{label}</kbd>}
                    </For>
                  )}
                </Show>
              }
            >
              <kbd>Press keys…</kbd>
            </Show>
            <IconButton
              label={`Change the shortcut for ${c.title}`}
              size="sm"
              onClick={() => startListening(c.id)}
            >
              <Icon name="edit" size={14} />
            </IconButton>
            <Show when={props.overrides[c.id] !== undefined}>
              <Button variant="secondary" size="sm" onClick={() => resetRow(c.id)}>
                Reset
              </Button>
            </Show>
            <Show when={errorFor()?.id === c.id}>
              <p
                role="alert"
                style={{
                  margin: 0,
                  "font-size": "var(--text-xs)",
                  color: "var(--c-warning)",
                }}
              >
                {errorFor()?.message}
              </p>
            </Show>
          </div>
        )}
      </For>
    </>
  );
};

export default ShortcutsPanel;
