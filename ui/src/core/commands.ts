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

/** A normalized key chord. `key` is always lower-cased. */
export interface KeyChord {
  mod: boolean;
  shift: boolean;
  alt: boolean;
  key: string;
}

/** Parse a CodeMirror-notation spec ("Mod-Shift-b") into a {@link KeyChord}. */
export function parseKeySpec(spec: string): KeyChord {
  const parts = spec.split("-");
  const key = parts[parts.length - 1].toLowerCase();
  const mods = parts.slice(0, -1).map((m) => m.toLowerCase());
  return {
    mod: mods.includes("mod"),
    shift: mods.includes("shift"),
    alt: mods.includes("alt"),
    key,
  };
}

interface KeyEventLike {
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  key: string;
}

/** Normalize a DOM keyboard event into a {@link KeyChord}. */
export function eventToChord(e: KeyEventLike): KeyChord {
  return {
    mod: e.metaKey || e.ctrlKey,
    shift: e.shiftKey,
    alt: e.altKey,
    key: e.key.toLowerCase(),
  };
}

/** True when `spec` exactly describes the chord of event `e`. */
export function chordMatches(spec: string, e: KeyEventLike): boolean {
  const a = parseKeySpec(spec);
  const b = eventToChord(e);
  return (
    a.mod === b.mod && a.shift === b.shift && a.alt === b.alt && a.key === b.key
  );
}

/**
 * Resolve a keyboard event to the global command it should run, or
 * `undefined`. Honors `when?.()` guards and ignores non-`global` bindings.
 */
export function resolveGlobal(
  bindings: readonly KeyBinding[],
  commands: Record<string, Command>,
  e: KeyEventLike,
): Command | undefined {
  for (const b of bindings) {
    if (b.scope !== "global") continue;
    if (!chordMatches(b.key, e)) continue;
    const c = commands[b.command];
    if (!c) continue;
    if (c.when && !c.when()) continue;
    return c;
  }
  return undefined;
}
