import { BACKLINKS_PANEL, MENTIONS_PANEL } from "../backlinks/sidebarPanels";
import { QUERY_PLUGIN } from "../dataview/registration";
import { AUTOCOMPLETE_PLUGIN } from "../editor/autocompleteRegistration";
import { EQUATIONS_PLUGIN } from "../editor/equationRegistration";
import { MATH_PLUGIN } from "../editor/mathRegistration";
import { PROPERTY_REFS_PLUGIN } from "../editor/propertyRefRegistration";
import { LEFT_SIDEBAR_MODES } from "../explorer/ExplorerPanel";
import { GRAPH_PLUGIN } from "../graph/registration";
import { GRAPH_TAB_KIND } from "../graph/tabView";
import { INTEGRITY_PLUGIN } from "../integrity/registration";
import { INTEGRITY_PANEL } from "../integrity/sidebarPanel";
import PropertiesSettings from "../properties/PropertiesSettings";
import { propertiesBlockSettings } from "../properties/formats";
import { SEARCH_PLUGIN } from "../search/registration";
import { registerBlockSettings } from "../settings/blockSettings";
import { registerCorePlugins } from "../settings/corePlugins";
import { registerPaneSlots } from "../settings/paneSlots";
import { registerSettingsSections } from "../settings/sections";
import {
  registerLeftSidebarModes,
  registerSidebarPanels,
} from "../settings/sidebarPanels";
import StatusbarPane from "../statusbar/StatusbarPane";
import { STATUSBAR_SEGMENTS } from "../statusbar/segments";
import {
  registerStatusbarSegments,
  statusbarBlockSettings,
} from "../statusbar/statusbarSettings";
import { registerTabKinds } from "../tabs/tabKinds";
import { TAG_TAB_KIND } from "../tags/tabKind";
import { TERMINAL_PLUGIN } from "../terminal/registration";
import { TERMINAL_TAB_KIND } from "../terminal/tabView";

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
  registerSidebarPanels([BACKLINKS_PANEL, MENTIONS_PANEL, INTEGRITY_PANEL]);
  registerLeftSidebarModes(LEFT_SIDEBAR_MODES);
  registerTabKinds([TAG_TAB_KIND, TERMINAL_TAB_KIND, GRAPH_TAB_KIND]);

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
