export type StartAction = "fetch:start" | "refresh:start";

const SEPARATOR = "\u0000";

export interface TargetTracker {
  start(...parts: string[]): { type: StartAction };
}

export function createTargetTracker(): TargetTracker {
  let last: string | null = null;
  return {
    start(...parts: string[]) {
      const target = parts.join(SEPARATOR);
      const type: StartAction =
        target === last ? "refresh:start" : "fetch:start";
      last = target;
      return { type };
    },
  };
}
