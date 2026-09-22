import type { CommandScope, KeyBinding } from "./commands";

export interface BindingDefault {
  id: string;
  title: string;
  scope: CommandScope;
  defaultKey?: string;
  plugin?: string;
}

export const CORE_COMMANDS: readonly BindingDefault[] = [
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
];

const registry: BindingDefault[] = [...CORE_COMMANDS];

export function registerCommands(contributed: readonly BindingDefault[]): void {
  for (const command of contributed) {
    if (!registry.some((c) => c.id === command.id)) registry.push(command);
  }
}

export function registeredCommands(): readonly BindingDefault[] {
  return registry;
}

export function activeCommands(
  isActive: (plugin: string) => boolean,
  commands: readonly BindingDefault[] = registry,
): BindingDefault[] {
  return commands.filter((c) => c.plugin === undefined || isActive(c.plugin));
}

export function resolveBindings(
  overrides: Record<string, string>,
  commands: readonly BindingDefault[] = registry,
): KeyBinding[] {
  const out: KeyBinding[] = [];
  for (const c of commands) {
    const key = overrides[c.id] || c.defaultKey;
    if (key) out.push({ key, command: c.id, scope: c.scope });
  }
  return out;
}

export function defaultBindings(): KeyBinding[] {
  return resolveBindings({});
}

export function sameCommands(
  a: readonly BindingDefault[],
  b: readonly BindingDefault[],
): boolean {
  return a.length === b.length && a.every((c, i) => c === b[i]);
}

export function sameBindings(
  a: readonly KeyBinding[],
  b: readonly KeyBinding[],
): boolean {
  return (
    a.length === b.length &&
    a.every(
      (x, i) =>
        x.key === b[i]!.key &&
        x.command === b[i]!.command &&
        x.scope === b[i]!.scope,
    )
  );
}
