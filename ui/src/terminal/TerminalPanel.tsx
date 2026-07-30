import {
  Show,
  createEffect,
  createSignal,
  on,
  onCleanup,
  onMount,
  type JSXElement,
} from "solid-js";

import type { ResolvedTheme } from "../styles/theme";
import { createEmulator, type Emulator } from "./emulator";
import {
  initialTerminalState,
  isFinished,
  reduceTerminal,
  type TerminalEvent,
  type TerminalState,
} from "./exitState";
import { isUsableSize, watchResize, type TerminalSize } from "./resize";
import { openSession, type TerminalSession } from "./session";
import { readTerminalAppearance } from "./theme";

const FALLBACK_SIZE: TerminalSize = { cols: 80, rows: 24 };

export interface TerminalPanelProps {
  vaultId: string;
  resolvedTheme: ResolvedTheme;
}

export function TerminalPanel(props: TerminalPanelProps): JSXElement {
  const [state, setState] = createSignal<TerminalState>(initialTerminalState);
  let screen: HTMLDivElement | undefined;
  let emulator: Emulator | undefined;
  let session: TerminalSession | undefined;

  const dispatch = (event: TerminalEvent) =>
    setState((s) => reduceTerminal(s, event));

  const measure = (): TerminalSize =>
    (emulator ? emulator.fit() : null) ?? emulator?.size() ?? FALLBACK_SIZE;

  const syncSize = () => {
    const size = measure();
    if (isUsableSize(size)) session?.resize(size);
  };

  onMount(() => {
    const host = screen;
    if (host === undefined) return;

    emulator = createEmulator(host, readTerminalAppearance());
    const stopWatching = watchResize(host, syncSize);
    onCleanup(stopWatching);

    void (async () => {
      try {
        const opened = await openSession(props.vaultId, measure(), {
          onBytes: (bytes) => emulator?.write(bytes),
          onExit: (exit) => dispatch({ type: "exited", exit }),
        });
        if (emulator === undefined) {
          void opened.close();
          return;
        }
        session = opened;
        emulator.onData((data) => opened.write(data));
        dispatch({ type: "opened" });
        syncSize();
        emulator.focus();
      } catch (err) {
        dispatch({ type: "open-failed", message: String(err) });
      }
    })();
  });

  createEffect(
    on(
      () => props.resolvedTheme,
      () => {
        emulator?.applyAppearance(readTerminalAppearance());
        syncSize();
      },
      { defer: true },
    ),
  );

  onCleanup(() => {
    const closing = session;
    session = undefined;
    emulator?.dispose();
    emulator = undefined;
    void closing?.close();
  });

  return (
    <div class="terminal">
      <div class="terminal__screen" ref={screen} />
      <Show when={isFinished(state()) ? state().notice : null}>
        {(notice) => (
          <div class="terminal__notice" role="status">
            {notice()}
          </div>
        )}
      </Show>
    </div>
  );
}
