import { type Component, createEffect, createSignal, For, onCleanup, Show } from "solid-js";
import {
  COMMAND_DEFAULTS,
  eventToChord,
  findConflict,
  formatChordForDisplay,
  resolveBindings,
  specFromChord,
  type CommandScope,
} from "../core/commands";

export interface ShortcutsPanelProps {
  /** Command id → key spec, only for commands the user has changed. */
  overrides: Record<string, string>;
  /** Called with the full next `overrides` object on every change. */
  onChange: (next: Record<string, string>) => void;
}

/**
 * Settings → Shortcuts. One editable row per `COMMAND_DEFAULTS` entry:
 * click "Change" to capture a new chord (Esc cancels, a same-scope
 * conflict shows inline and keeps capture open), "Reset" removes the
 * override so the command falls back to its default.
 */
const ShortcutsPanel: Component<ShortcutsPanelProps> = (props) => {
  const [listeningId, setListeningId] = createSignal<string | null>(null);
  const [errorFor, setErrorFor] = createSignal<{ id: string; message: string } | null>(
    null,
  );

  const effectiveBindings = () => resolveBindings(props.overrides);
  const keyFor = (id: string) =>
    effectiveBindings().find((b) => b.command === id)?.key ?? "";

  const startListening = (id: string) => {
    setListeningId(id);
    setErrorFor(null);
  };

  // Capture the next keydown at the window while a row is listening.
  // Runs in the capture phase so it wins over any other handler
  // (including CodeMirror's own keymap, if an editor happens to be
  // focused underneath the Settings modal).
  createEffect(() => {
    const id = listeningId();
    if (id === null) return;
    const target = COMMAND_DEFAULTS.find((c) => c.id === id);
    if (!target) return;
    const scope: CommandScope = target.scope;

    const handler = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
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
      const conflictWith = findConflict(spec, scope, effectiveBindings(), id);
      if (conflictWith) {
        const title =
          COMMAND_DEFAULTS.find((c) => c.id === conflictWith)?.title ??
          conflictWith;
        setErrorFor({ id, message: `Already used by ${title}` });
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
      <h2 class="modal__h2">Shortcuts</h2>
      <For each={COMMAND_DEFAULTS}>
        {(c) => (
          <div class="kb-row">
            <span>{c.title}</span>
            <Show
              when={listeningId() === c.id}
              fallback={
                <For each={formatChordForDisplay(keyFor(c.id))}>
                  {(label) => <kbd>{label}</kbd>}
                </For>
              }
            >
              <kbd>Press keys…</kbd>
            </Show>
            <button type="button" class="chrome-btn" onClick={() => startListening(c.id)}>
              Change
            </button>
            <Show when={props.overrides[c.id] !== undefined}>
              <button type="button" class="chrome-btn" onClick={() => resetRow(c.id)}>
                Reset
              </button>
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
