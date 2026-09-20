import type { SidebarPanel } from "../settings/sidebarPanels";
import IntegrityPanel from "./IntegrityPanel";

export const INTEGRITY_PANEL: SidebarPanel = {
  id: "integrity",
  label: "Integrity",
  order: 30,
  panel: (props) => (
    <IntegrityPanel
      vaultId={props.vaultId}
      refreshSignal={props.refreshSignal}
      onRowClick={props.onNavigate}
      onRepaired={() => props.onRefresh()}
    />
  ),
};
