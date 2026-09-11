import { QUERY_PLUGIN } from "../dataview/registration";
import { EQUATIONS_PLUGIN } from "../editor/equationRegistration";
import { MATH_PLUGIN } from "../editor/mathRegistration";
import { PROPERTY_REFS_PLUGIN } from "../editor/propertyRefRegistration";
import { GRAPH_PLUGIN } from "../graph/registration";
import { registerCorePlugins } from "../settings/corePlugins";
import { registerStatusbarSegments } from "../settings/statusbarSettings";
import { STATUSBAR_SEGMENTS } from "../statusbar/segments";
import { TERMINAL_PLUGIN } from "../terminal/registration";

export function registerBlocks(): void {
  registerCorePlugins([
    QUERY_PLUGIN,
    PROPERTY_REFS_PLUGIN,
    MATH_PLUGIN,
    EQUATIONS_PLUGIN,
    TERMINAL_PLUGIN,
    GRAPH_PLUGIN,
  ]);
  registerStatusbarSegments(STATUSBAR_SEGMENTS);
}
