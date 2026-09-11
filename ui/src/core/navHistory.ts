export interface NavState {
  stack: string[];
  index: number;
}

export const emptyNav: NavState = { stack: [], index: -1 };

export function navCurrent(s: NavState): string | null {
  return s.index >= 0 && s.index < s.stack.length
    ? (s.stack[s.index] as string)
    : null;
}

export function canBack(s: NavState): boolean {
  return s.index > 0;
}

export function canForward(s: NavState): boolean {
  return s.index < s.stack.length - 1;
}

export function navPush(s: NavState, path: string): NavState {
  if (navCurrent(s) === path) return s;
  const stack = s.stack.slice(0, s.index + 1);
  stack.push(path);
  return { stack, index: stack.length - 1 };
}

export function navBack(s: NavState): NavState {
  return canBack(s) ? { stack: s.stack, index: s.index - 1 } : s;
}

export function navForward(s: NavState): NavState {
  return canForward(s) ? { stack: s.stack, index: s.index + 1 } : s;
}
