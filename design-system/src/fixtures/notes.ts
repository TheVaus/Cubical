export interface Note {
  id: string;
  title: string;
  frontmatter: Record<string, string>;
  body: string;
  tags: string[];
}

export const activeNote: Note = {
  id: 'design-notes',
  title: 'Design notes',
  frontmatter: {
    created: '2026-07-10',
    status: 'active',
  },
  tags: ['design', 'cubical'],
  body: `# Design notes

The accent color means state, never decoration. See [[Cubical roadmap]] for
sequencing.

## Open questions

- Should the minimap show heading density or line density?
- Confirm high-contrast theme pairs with [[Old spec]] (broken link).
`,
};
