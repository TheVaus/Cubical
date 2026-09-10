import { GRAPH_PLUGIN } from "../graph/registration";
import { registerCorePlugins } from "../settings/corePlugins";
import { registerStatusbarSegments } from "../settings/statusbarSettings";
import { STATUSBAR_SEGMENTS } from "../statusbar/segments";
import { TERMINAL_PLUGIN } from "../terminal/registration";

export function registerBlocks(): void {
  registerCorePlugins([TERMINAL_PLUGIN, GRAPH_PLUGIN]);
  registerStatusbarSegments(STATUSBAR_SEGMENTS);
}
