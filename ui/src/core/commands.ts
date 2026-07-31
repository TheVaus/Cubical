export type CommandScope = "global" | "editor";

export interface Command {
  id: string;
  title: string;
  run: () => void;
  when?: () => boolean;
}

export interface KeyBinding {
  key: string;
  command: string;
  scope: CommandScope;
}

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
  {
    id: "editor.followWikilink",
    title: "Follow link under cursor",
    scope: "editor",
    defaultKey: "Alt-Enter",
  },
  {
    id: "view.toggleSidebar",
    title: "Toggle left sidebar",
    scope: "global",
    defaultKey: "Mod-Shift-l",
  },
  {
    id: "file.new",
    title: "New note",
    scope: "global",
    defaultKey: "Mod-n",
  },
  {
    id: "nav.back",
    title: "Navigate back",
    scope: "global",
    defaultKey: "Mod-Alt-ArrowLeft",
  },
  {
    id: "nav.forward",
    title: "Navigate forward",
    scope: "global",
    defaultKey: "Mod-Alt-ArrowRight",
  },
  {
    id: "view.nextTab",
    title: "Next tab",
    scope: "global",
    defaultKey: "Mod-Tab",
  },
  {
    id: "view.prevTab",
    title: "Previous tab",
    scope: "global",
    defaultKey: "Mod-Shift-Tab",
  },
  {
    id: "view.closeTab",
    title: "Close tab",
    scope: "global",
    defaultKey: "Mod-Shift-w",
  },
  {
    id: "view.openConsole",
    title: "Open command console",
    scope: "global",
    defaultKey: "Mod-Shift-c",
  },
  {
    id: "view.openTerminal",
    title: "Open terminal",
    scope: "global",
    defaultKey: "Mod-Shift-t",
  },
];

export const DEFAULT_BINDINGS: readonly KeyBinding[] = COMMAND_DEFAULTS.map(
  (c) => ({ key: c.defaultKey, command: c.id, scope: c.scope }),
);

export function resolveBindings(
  overrides: Record<string, string>,
): KeyBinding[] {
  return COMMAND_DEFAULTS.map((c) => ({
    key: overrides[c.id] || c.defaultKey,
    command: c.id,
    scope: c.scope,
  }));
}

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

export interface KeyChord {
  mod: boolean;
  shift: boolean;
  alt: boolean;
  key: string;
}

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

export function eventToChord(e: KeyEventLike): KeyChord {
  return {
    mod: e.metaKey || e.ctrlKey,
    shift: e.shiftKey,
    alt: e.altKey,
    key: e.key.toLowerCase(),
  };
}

export function chordMatches(spec: string, e: KeyEventLike): boolean {
  const a = parseKeySpec(spec);
  const b = eventToChord(e);
  return (
    a.mod === b.mod && a.shift === b.shift && a.alt === b.alt && a.key === b.key
  );
}

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

export function specFromChord(chord: KeyChord): string {
  const mods: string[] = [];
  if (chord.mod) mods.push("Mod");
  if (chord.shift) mods.push("Shift");
  if (chord.alt) mods.push("Alt");
  return [...mods, chord.key].join("-");
}

const SPECIAL_KEY_LABELS: Record<string, string> = {
  enter: "Enter",
  arrowleft: "←",
  arrowright: "→",
  arrowup: "↑",
  arrowdown: "↓",
  escape: "Esc",
  tab: "Tab",
  " ": "Space",
};

export function formatChordForDisplay(spec: string): string[] {
  const chord = parseKeySpec(spec);
  const labels: string[] = [];
  if (chord.mod) labels.push("⌘/Ctrl");
  if (chord.shift) labels.push("⇧");
  if (chord.alt) labels.push("⌥/Alt");
  labels.push(
    chord.key.length === 1
      ? chord.key.toUpperCase()
      : SPECIAL_KEY_LABELS[chord.key] ?? chord.key,
  );
  return labels;
}

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
