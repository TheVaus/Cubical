export interface Backlink {
  id: string;
  noteTitle: string;
  snippet: string;
}

export const backlinks: Backlink[] = [
  { id: 'roadmap-1', noteTitle: 'Cubical roadmap', snippet: 'Design notes cover the accent-as-state rule in depth.' },
  { id: 'daily-1', noteTitle: '2026-07-12', snippet: 'Reviewed design notes before standup.' },
];

export const unlinkedMentions: Backlink[] = [
  { id: 'moodboard-1', noteTitle: 'moodboard', snippet: 'File referenced by name only, no [[wiki-link]] yet.' },
];
