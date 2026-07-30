import { For, Show, createSignal, type JSXElement } from "solid-js";

import { consoleExec } from "../api/ipc";
import { emptyHistory, push, up, down, type History } from "./history";
import { append, type Entry } from "./scrollback";

export function ConsolePanel(props: { vaultId: string }): JSXElement {
  const [entries, setEntries] = createSignal<Entry[]>([]);
  const [value, setValue] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  let history: History = emptyHistory;

  const run = async () => {
    const line = value();
    if (line.trim() === "" || busy()) return;
    history = push(history, line);
    setEntries((e) => append(e, [{ kind: "input", text: line }]));
    setValue("");
    setBusy(true);
    try {
      const res = await consoleExec(props.vaultId, line);
      const next: Entry[] = [];
      if (res.stdout !== "") next.push({ kind: "stdout", text: res.stdout.replace(/\n$/, "") });
      if (res.stderr !== "") next.push({ kind: "stderr", text: res.stderr.replace(/\n$/, "") });
      if (next.length > 0) setEntries((e) => append(e, next));
    } catch (err) {
      setEntries((e) => append(e, [{ kind: "stderr", text: String(err) }]));
    } finally {
      setBusy(false);
    }
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      void run();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      const r = up(history);
      history = r.history;
      if (r.value !== null) setValue(r.value);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      const r = down(history);
      history = r.history;
      setValue(r.value ?? "");
    }
  };

  return (
    <div class="console">
      <div class="console__scrollback">
        <For each={entries()}>
          {(entry) => (
            <div class={`console__entry console__entry--${entry.kind}`}>
              <Show when={entry.kind === "input"} fallback={
                <For each={entry.text.split("\n")}>
                  {(line) => <div class="console__line">{line}</div>}
                </For>
              }>
                <div class="console__line">{`› ${entry.text}`}</div>
              </Show>
            </div>
          )}
        </For>
      </div>
      <input
        class="console__input"
        aria-label="Console input"
        spellcheck={false}
        autocomplete="off"
        placeholder="Type a cubical command, e.g. list"
        value={value()}
        disabled={busy()}
        onInput={(e) => setValue(e.currentTarget.value)}
        onKeyDown={onKeyDown}
      />
    </div>
  );
}
