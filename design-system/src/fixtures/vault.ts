import type { FileKind } from '../components/data/FileTreeRow/FileIcon';

export interface VaultNode {
  id: string;
  name: string;
  kind: FileKind;
  children?: VaultNode[];
}

export const vaultTree: VaultNode[] = [
  {
    id: 'projects',
    name: 'Projects',
    kind: 'folder',
    children: [
      { id: 'cubical-roadmap', name: 'Cubical roadmap.md', kind: 'md' },
      { id: 'design-notes', name: 'Design notes.md', kind: 'md' },
      { id: 'old-spec', name: 'Old spec.md', kind: 'broken' },
    ],
  },
  {
    id: 'daily',
    name: 'Daily',
    kind: 'folder',
    children: [
      { id: '2026-07-12', name: '2026-07-12.md', kind: 'md' },
      { id: '2026-07-13', name: '2026-07-13.md', kind: 'md' },
    ],
  },
  { id: 'moodboard', name: 'moodboard.png', kind: 'png' },
  { id: 'cube-mark', name: 'cube-mark.svg', kind: 'svg' },
  { id: 'readme', name: 'README.txt', kind: 'txt' },
];
