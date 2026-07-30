import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";

import type { TerminalSize } from "./resize";
import type { TerminalAppearance } from "./theme";

export interface Emulator {
  write(bytes: Uint8Array): void;
  resize(cols: number, rows: number): void;
  fit(): TerminalSize | null;
  size(): TerminalSize;
  applyAppearance(appearance: TerminalAppearance): void;
  onData(handler: (data: string) => void): void;
  focus(): void;
  dispose(): void;
}

export type CreateEmulator = (
  container: HTMLElement,
  appearance: TerminalAppearance,
) => Emulator;

const SCROLLBACK = 5000;

export const createEmulator: CreateEmulator = (container, appearance) => {
  const term = new Terminal({
    allowTransparency: true,
    convertEol: false,
    cursorBlink: true,
    fontFamily: appearance.fontFamily,
    fontSize: appearance.fontSize,
    lineHeight: appearance.lineHeight,
    scrollback: SCROLLBACK,
    theme: appearance.theme,
  });
  const fitAddon = new FitAddon();
  term.loadAddon(fitAddon);
  term.open(container);

  return {
    write: (bytes) => term.write(bytes),
    resize: (cols, rows) => term.resize(cols, rows),
    fit: () => {
      const proposed = fitAddon.proposeDimensions();
      if (proposed === undefined) return null;
      fitAddon.fit();
      return { cols: term.cols, rows: term.rows };
    },
    size: () => ({ cols: term.cols, rows: term.rows }),
    applyAppearance: (next) => {
      term.options.fontFamily = next.fontFamily;
      term.options.fontSize = next.fontSize;
      term.options.lineHeight = next.lineHeight;
      term.options.theme = next.theme;
    },
    onData: (handler) => {
      term.onData(handler);
    },
    focus: () => term.focus(),
    dispose: () => term.dispose(),
  };
};
