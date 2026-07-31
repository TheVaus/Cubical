export { TerminalButton } from "./TerminalButton";
export { TerminalCloseDialog, TerminalConsentDialog } from "./TerminalDialogs";
export { TerminalPanel } from "./TerminalPanel";
export {
  TERMINAL_COMMAND_ID,
  TERMINAL_COMMAND_TITLE,
  TERMINAL_PLUGIN,
} from "./registration";
export { isTerminalView, terminalTabIds, terminalView } from "./tabView";
export {
  createTerminalWiring,
  type ConsentPrompt,
  type TerminalWiring,
  type TerminalWiringDeps,
} from "./wiring";
