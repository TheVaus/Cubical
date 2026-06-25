/**
 * Core substrate — command + keymap registry.
 *
 * Pure: types, the static binding table, key-string matching, and command
 * resolution. No DOM, no Solid; imports nothing from any feature. Adapters
 * (App.tsx global keydown, Editor.tsx CodeMirror keymap) inject the `run`
 * closures and wire this to their runtime. Bindings are a static const table
 * in v1 — no user remapping.
 */

/** Where a binding is active. */
export type CommandScope = "global" | "editor";

/** An invokable app action. `run` closures are supplied by adapters. */
export interface Command {
  id: string;
  title: string;
  run: () => void;
  /** Optional guard; when present and false, the binding does not fire. */
  when?: () => boolean;
}

/** A key → command mapping within a scope. Key uses CodeMirror notation. */
export interface KeyBinding {
  key: string;
  command: string;
  scope: CommandScope;
}

/**
 * The v1 binding table. Editor-scope entries are handed to CodeMirror;
 * global-scope entries are matched by the App-level keydown adapter.
 */
export const DEFAULT_BINDINGS: readonly KeyBinding[] = [
  { key: "Mod-k", command: "omnibar.toggle", scope: "global" },
  { key: "Mod-e", command: "editor.toggleRawSource", scope: "editor" },
  { key: "Mod-Shift-b", command: "editor.copyBlockRef", scope: "editor" },
];

/** Returns `"scope:key"` for every (scope, key) claimed more than once. */
export function findDuplicateBindings(
  bindings: readonly KeyBinding[],
): string[] {
  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const b of bindings) {
    const id = `${b.scope}:${b.key}`;
    if (seen.has(id)) dupes.add(id);
    seen.add(id);
  }
  return [...dupes];
}
