import { QUERY_PLUGIN } from "../dataview/registration";
import { EQUATIONS_PLUGIN } from "../editor/equationRegistration";
import { MATH_PLUGIN } from "../editor/mathRegistration";
import { PROPERTY_REFS_PLUGIN } from "../editor/propertyRefRegistration";
import { GRAPH_PLUGIN } from "../graph/registration";
import PropertiesSettings from "../properties/PropertiesSettings";
import { propertiesBlockSettings } from "../properties/formats";
import { registerBlockSettings } from "../settings/blockSettings";
import { registerCorePlugins } from "../settings/corePlugins";
import { registerPaneSlots } from "../settings/paneSlots";
import { registerSettingsSections } from "../settings/sections";
import StatusbarPane from "../statusbar/StatusbarPane";
import { STATUSBAR_SEGMENTS } from "../statusbar/segments";
import {
  registerStatusbarSegments,
  statusbarBlockSettings,
} from "../statusbar/statusbarSettings";
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

  registerSettingsSections([
    {
      id: "statusbar",
      icon: "bar-chart",
      label: "Status bar",
      order: 50,
      pane: StatusbarPane,
    },
  ]);
  registerPaneSlots([
    {
      id: "properties",
      host: "editor",
      order: 10,
      pane: PropertiesSettings,
    },
  ]);
  registerBlockSettings([
    ...statusbarBlockSettings(),
    ...propertiesBlockSettings(),
  ]);
}
