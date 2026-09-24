import { describe, expect, it } from "vitest";

import {
  activeCommands,
  CORE_COMMANDS,
  type BindingDefault,
} from "../core/commandRegistry";
import type { Command } from "../core/commands";
import { GRAPH_COMMAND } from "../graph/registration";
import { STATUSBAR_COMMAND } from "../statusbar/commands";
import { TERMINAL_COMMAND } from "../terminal/registration";
import { paletteCommands } from "./paletteCommands";
import { OMNIBAR_COMMAND } from "./registration";

const all: readonly BindingDefault[] = [
  ...CORE_COMMANDS,
  OMNIBAR_COMMAND,
  TERMINAL_COMMAND,
  GRAPH_COMMAND,
  STATUSBAR_COMMAND,
];

const handler = (id: string, when?: () => boolean): Command => ({
  id,
  run: () => {},
  ...(when ? { when } : {}),
});

const handlers: Record<string, Command> = Object.fromEntries(
  [OMNIBAR_COMMAND, TERMINAL_COMMAND, GRAPH_COMMAND, STATUSBAR_COMMAND].map(
    (c) => [c.id, handler(c.id)],
  ),
);

const ids = (items: ReturnType<typeof paletteCommands>) =>
  items.map((i) => (i.kind === "command" ? i.id : ""));

describe("paletteCommands", () => {
  it("lists every active command that has a handler", () => {
    expect(ids(paletteCommands(activeCommands(() => true, all), handlers))).toEqual([
      "view.openTerminal",
      "graph.open",
      "statusbar.toggle",
    ]);
  });

  it("omits a switched-off block's command", () => {
    const active = activeCommands((p) => p !== GRAPH_COMMAND.plugin, all);
    expect(ids(paletteCommands(active, handlers))).not.toContain("graph.open");
  });

  it("brings the command back when the block is switched on again", () => {
    const off = activeCommands((p) => p !== GRAPH_COMMAND.plugin, all);
    expect(ids(paletteCommands(off, handlers))).not.toContain("graph.open");
    const on = activeCommands(() => true, all);
    expect(ids(paletteCommands(on, handlers))).toContain("graph.open");
  });

  it("omits a command whose handler says it cannot run now", () => {
    const blocked = { ...handlers, "graph.open": handler("graph.open", () => false) };
    expect(ids(paletteCommands(all, blocked))).not.toContain("graph.open");
  });

  it("never lists its own toggle", () => {
    expect(ids(paletteCommands(all, handlers))).not.toContain(OMNIBAR_COMMAND.id);
  });

  it("uses the registered title", () => {
    const item = paletteCommands([GRAPH_COMMAND], handlers)[0];
    expect(item).toEqual({
      kind: "command",
      id: GRAPH_COMMAND.id,
      title: GRAPH_COMMAND.title,
    });
  });
});
