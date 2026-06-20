/**
 * Omni-bar command registry — pure data. Each command has a stable `id` (the
 * dispatch key, handled in App) and a searchable `title`. App maps `id` →
 * effect; descriptors hold no app state.
 */
export interface OmniCommand {
  id: string;
  title: string;
}

export const OMNI_COMMANDS: OmniCommand[] = [
  { id: "statusbar.toggle", title: "Toggle status bar" },
];
