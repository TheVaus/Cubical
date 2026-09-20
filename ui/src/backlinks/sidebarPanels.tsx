import type { SidebarPanel } from "../settings/sidebarPanels";
import Backlinks from "./Backlinks";
import UnlinkedMentions from "./UnlinkedMentions";

export const BACKLINKS_PANEL: SidebarPanel = {
  id: "backlinks",
  label: "Backlinks",
  order: 10,
  panel: (props) => (
    <Backlinks
      vaultId={props.vaultId}
      path={props.path}
      refreshSignal={props.refreshSignal}
      onRowClick={props.onNavigate}
    />
  ),
};

export const MENTIONS_PANEL: SidebarPanel = {
  id: "unlinked_mentions",
  label: "Mentions",
  order: 20,
  panel: (props) => (
    <UnlinkedMentions
      vaultId={props.vaultId}
      path={props.path}
      refreshSignal={props.refreshSignal}
      onRowClick={props.onNavigate}
    />
  ),
};
