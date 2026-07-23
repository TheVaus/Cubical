export interface Span {
  start: number;
  end: number;
}

export type FrontmatterEntry = readonly [key: string, value: unknown];

export interface Frontmatter {
  entries: FrontmatterEntry[];
  span: Span;
}

export interface CanonicalDocument {
  frontmatter: Frontmatter | null;
  blocks: Block[];
  source_len: number;
}

export type Block =
  | { kind: "heading"; level: 1 | 2 | 3 | 4 | 5 | 6; inlines: Inline[]; span: Span }
  | { kind: "paragraph"; inlines: Inline[]; span: Span }
  | { kind: "list"; ordered: boolean; items: ListItem[]; span: Span }
  | { kind: "code_block"; lang: string | null; content: string; span: Span }
  | { kind: "quote"; blocks: Block[]; span: Span }
  | { kind: "thematic_break"; span: Span }
  | { kind: "html"; content: string; span: Span };

export interface ListItem {
  blocks: Block[];
  span: Span;
}

export type Anchor =
  | { kind: "heading"; value: string }
  | { kind: "block"; value: string };

export type Inline =
  | { kind: "text"; value: string }
  | { kind: "emph"; children: Inline[] }
  | { kind: "strong"; children: Inline[] }
  | { kind: "code"; value: string }
  | { kind: "link"; dest: string; title: string | null; children: Inline[] }
  | { kind: "image"; dest: string; title: string | null; alt: Inline[] }
  | { kind: "line_break" }
  | {
      kind: "wiki_link";
      target: string;
      display: string | null;
      anchor: Anchor | null;
      embed: boolean;
    }
  | { kind: "property_ref"; note: string | null; property: string }
  | { kind: "tag"; path: string };
