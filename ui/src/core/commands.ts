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
 * Metadata for every rebindable command: its default key, human-readable
 * title (for the Settings → Shortcuts UI), and scope. `DEFAULT_BINDINGS`
 * and the Settings panel are both derived from this one table, so adding
 * a command later only means adding one entry here.
 */
export interface BindingDefault {
  id: string;
  title: string;
  scope: CommandScope;
  defaultKey: string;
}

export const COMMAND_DEFAULTS: readonly BindingDefault[] = [
  {
    id: "omnibar.toggle",
    title: "Open Omni-Bar",
    scope: "global",
    defaultKey: "Mod-k",
  },
  {
    id: "editor.toggleRawSource",
    title: "Toggle raw source / Live Preview",
    scope: "editor",
    defaultKey: "Mod-e",
  },
  {
    id: "editor.copyBlockRef",
    title: "Copy block reference",
    scope: "editor",
    defaultKey: "Mod-Shift-b",
  },
];

/**
 * The v1 binding table. Editor-scope entries are handed to CodeMirror;
 * global-scope entries are matched by the App-level keydown adapter.
 */
export const DEFAULT_BINDINGS: readonly KeyBinding[] = COMMAND_DEFAULTS.map(
  (c) => ({ key: c.defaultKey, command: c.id, scope: c.scope }),
);

/**
 * Merge `overrides` (command id → key spec, from the `shortcuts.overrides`
 * setting) with {@link COMMAND_DEFAULTS} into the effective binding table.
 * A diff, not a snapshot: a command with no entry in `overrides` falls
 * through to its default, so a future default-table change is picked up
 * automatically. An override whose key no longer matches any
 * `COMMAND_DEFAULTS` entry is silently ignored — this only ever iterates
 * the default table, never the override object's own keys.
 */
export function resolveBindings(
  overrides: Record<string, string>,
): KeyBinding[] {
  return COMMAND_DEFAULTS.map((c) => ({
    key: overrides[c.id] ?? c.defaultKey,
    command: c.id,
    scope: c.scope,
  }));
}

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
  const key = (parts[parts.length - 1] ?? "").toLowerCase();
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
 * Returns the command id already bound to `spec` within `scope` (ignoring
 * `excludeCommandId`, so re-capturing a row's own current key never
 * conflicts with itself), or `undefined` if `spec` is free. `global` and
 * `editor` are independent key spaces — a match in the other scope is not
 * a conflict.
 */
export function findConflict(
  spec: string,
  scope: CommandScope,
  bindings: readonly KeyBinding[],
  excludeCommandId: string,
): string | undefined {
  const chord = parseKeySpec(spec);
  for (const b of bindings) {
    if (b.scope !== scope) continue;
    if (b.command === excludeCommandId) continue;
    const other = parseKeySpec(b.key);
    if (
      other.mod === chord.mod &&
      other.shift === chord.shift &&
      other.alt === chord.alt &&
      other.key === chord.key
    ) {
      return b.command;
    }
  }
  return undefined;
}

/** Build a key spec string (CodeMirror notation) from a captured chord. */
export function specFromChord(chord: KeyChord): string {
  const mods: string[] = [];
  if (chord.mod) mods.push("Mod");
  if (chord.shift) mods.push("Shift");
  if (chord.alt) mods.push("Alt");
  return [...mods, chord.key].join("-");
}

/**
 * Render a key spec as the ordered `<kbd>` labels the Settings UI
 * displays (e.g. `"Mod-Shift-b"` → `["⌘/Ctrl", "⇧", "B"]`). `parseKeySpec`
 * always lower-cases the key; this uppercases single-character keys for
 * display since that's how the previous hand-written Settings JSX showed
 * them.
 */
export function formatChordForDisplay(spec: string): string[] {
  const chord = parseKeySpec(spec);
  const labels: string[] = [];
  if (chord.mod) labels.push("⌘/Ctrl");
  if (chord.shift) labels.push("⇧");
  if (chord.alt) labels.push("⌥/Alt");
  labels.push(chord.key.length === 1 ? chord.key.toUpperCase() : chord.key);
  return labels;
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

/**
 * Build CodeMirror keymap entries from the `editor`-scope bindings. Each
 * `run` invokes the command (honoring `when?.()`) and returns `true` when it
 * ran so CodeMirror stops, `false` to fall through to later handlers. The
 * returned shape is CodeMirror's `KeyBinding` ({ key, run }).
 */
export function toCmBindings(
  bindings: readonly KeyBinding[],
  commands: Record<string, Command>,
): { key: string; run: () => boolean }[] {
  const out: { key: string; run: () => boolean }[] = [];
  for (const b of bindings) {
    if (b.scope !== "editor") continue;
    const c = commands[b.command];
    if (!c) continue;
    out.push({
      key: b.key,
      run: () => {
        if (c.when && !c.when()) return false;
        c.run();
        return true;
      },
    });
  }
  return out;
}
