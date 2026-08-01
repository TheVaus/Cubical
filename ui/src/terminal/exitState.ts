import type { TerminalExit } from "../api/ipc";

export type TerminalPhase = "opening" | "running" | "exited" | "failed";

export interface TerminalState {
  phase: TerminalPhase;
  notice: string | null;
}

export type TerminalEvent =
  | { type: "opened" }
  | { type: "open-failed"; message: string }
  | { type: "exited"; exit: TerminalExit | null };

export const initialTerminalState: TerminalState = {
  phase: "opening",
  notice: null,
};

export function isFinished(state: TerminalState): boolean {
  return state.phase === "exited" || state.phase === "failed";
}

export function exitNotice(exit: TerminalExit | null): string {
  if (exit === null) return "Process ended.";
  if (exit.signal !== null) return `Process killed by signal ${exit.signal}.`;
  if (exit.code !== null) return `Process exited with code ${exit.code}.`;
  return "Process ended.";
}

export function reduceTerminal(
  state: TerminalState,
  event: TerminalEvent,
): TerminalState {
  if (isFinished(state)) return state;
  switch (event.type) {
    case "opened":
      return state.phase === "opening"
        ? { phase: "running", notice: null }
        : state;
    case "open-failed":
      return state.phase === "opening"
        ? { phase: "failed", notice: `Terminal failed to start: ${event.message}` }
        : state;
    case "exited":
      return { phase: "exited", notice: exitNotice(event.exit) };
  }
}
