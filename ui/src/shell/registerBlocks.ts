import { QUERY_PLUGIN } from "../dataview/registration";
import { AUTOCOMPLETE_PLUGIN } from "../editor/autocompleteRegistration";
import { EQUATIONS_PLUGIN } from "../editor/equationRegistration";
import { MATH_PLUGIN } from "../editor/mathRegistration";
import { PROPERTY_REFS_PLUGIN } from "../editor/propertyRefRegistration";
import { GRAPH_PLUGIN } from "../graph/registration";
import { INTEGRITY_PLUGIN } from "../integrity/registration";
import { SEARCH_PLUGIN } from "../search/registration";
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
    SEARCH_PLUGIN,
    AUTOCOMPLETE_PLUGIN,
    INTEGRITY_PLUGIN,
  ]);
  registerStatusbarSegments(STATUSBAR_SEGMENTS);
}
