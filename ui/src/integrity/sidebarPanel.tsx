import type { SidebarPanel } from "../settings/sidebarPanels";
import IntegrityPanel from "./IntegrityPanel";
import { INTEGRITY_PLUGIN } from "./registration";

export const INTEGRITY_PANEL: SidebarPanel = {
  id: "integrity",
  label: "Integrity",
  order: 30,
  plugin: INTEGRITY_PLUGIN.id,
  panel: (props) => (
    <IntegrityPanel
      vaultId={props.vaultId}
      refreshSignal={props.refreshSignal}
      onRowClick={props.onNavigate}
      onRepaired={() => props.onRefresh()}
    />
  ),
};
