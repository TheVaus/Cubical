import { createMemo, createSignal } from "solid-js";

import {
  canBack,
  canForward,
  emptyNav,
  navBack,
  navCurrent,
  navForward,
  navPush,
  type NavState,
} from "../navHistory";

export interface NavSession {
  readonly canBack: () => boolean;
  readonly canForward: () => boolean;
  readonly current: () => string | null;
  readonly push: (path: string) => void;
  readonly back: () => string | null;
  readonly forward: () => string | null;
  readonly reset: () => void;
}

export function createNavSession(): NavSession {
  const [state, setState] = createSignal<NavState>(emptyNav);

  const step = (next: NavState): string | null => {
    if (next.index === state().index) return null;
    setState(next);
    return navCurrent(next);
  };

  return {
    canBack: createMemo(() => canBack(state())),
    canForward: createMemo(() => canForward(state())),
    current: () => navCurrent(state()),
    push: (path: string) => setState((s) => navPush(s, path)),
    back: () => step(navBack(state())),
    forward: () => step(navForward(state())),
    reset: () => setState(emptyNav),
  };
}
