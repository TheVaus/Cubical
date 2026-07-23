export interface OmniCommand {
  id: string;
  title: string;
}

export const OMNI_COMMANDS: OmniCommand[] = [
  { id: "statusbar.toggle", title: "Toggle status bar" },
];
