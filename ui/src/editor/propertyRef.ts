import {
  Decoration,
  EditorView,
  WidgetType,
  type DecorationSet,
} from "@codemirror/view";
import {
  Facet,
  type EditorState,
  type Extension,
  type Range,
} from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";

import { scanWikilinks } from "../ast/wikilink";
import { splitFrontmatter, parseFrontmatterYaml } from "../ast/frontmatter";
import { decorationField, offActiveLine } from "./decorationField";
import {
  propertyResolverFacet,
  propertyResolverUpdated,
  type PropertyResolver,
} from "./propertySlot";
import {
  renderPropertyRef,
  type PropertyRefRenderState,
} from "./propertyRefRender";

export const propertyRefsEnabledFacet = Facet.define<boolean, boolean>({
  combine: (values) => values[0] ?? true,
});

export { propertyResolverFacet, propertyResolverUpdated };

function scalarToDisplay(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    const parts = value
      .map((v) => scalarToDisplay(v))
      .filter((v): v is string => v !== null);
    return parts.length ? parts.join(", ") : null;
  }
  return null;
}

export function frontmatterEntries(docText: string): Map<string, unknown> {
  const split = splitFrontmatter(docText);
  if (split.yaml === null || split.span === null) return new Map();
  const fm = parseFrontmatterYaml(split.yaml, split.span);
  return new Map(fm?.entries ?? []);
}

export function selfPropertyValue(docText: string, property: string): unknown {
  const entries = frontmatterEntries(docText);
  return entries.has(property) ? entries.get(property) : undefined;
}

function selfValue(
  entries: Map<string, unknown>,
  property: string,
): string | null {
  return entries.has(property) ? scalarToDisplay(entries.get(property)) : null;
}

class PropertyRefWidget extends WidgetType {
  constructor(private readonly render: PropertyRefRenderState) {
    super();
  }

  override toDOM(): HTMLElement {
    return renderPropertyRef(this.render);
  }

  override eq(other: PropertyRefWidget): boolean {
    return JSON.stringify(this.render) === JSON.stringify(other.render);
  }

  override ignoreEvent(): boolean {
    return false;
  }
}

function renderStateFor(
  tok: { note: string | null; property: string },
  raw: string,
  ownEntries: () => Map<string, unknown>,
  resolver: PropertyResolver | null,
): PropertyRefRenderState {
  if (tok.note === null) {
    const v = selfValue(ownEntries(), tok.property);
    return v === null ? { status: "broken", raw } : { status: "resolved", value: v };
  }
  const hit = resolver?.get(tok.note, tok.property);
  if (!hit) {
    resolver?.fetch(tok.note, tok.property);
    return { status: "loading", raw };
  }
  if (hit.kind === "resolved") {
    const display = scalarToDisplay(hit.value);
    if (display !== null) return { status: "resolved", value: display };
  }
  return { status: "broken", raw };
}

function collectPropertyRefs(state: EditorState): Range<Decoration>[] {
  if (!state.facet(propertyRefsEnabledFacet)) return [];
  const resolver = state.facet(propertyResolverFacet);
  const tree = syntaxTree(state);
  const doc = state.doc;
  let own: Map<string, unknown> | undefined;
  const ownEntries = () => (own ??= frontmatterEntries(doc.toString()));
  const ranges: Range<Decoration>[] = [];

  tree.iterate({
    enter: (node) => {
      if (node.name !== "WikiLink") return;
      const raw = doc.sliceString(node.from, node.to);
      const tok = scanWikilinks(raw)[0];
      if (!tok || tok.kind !== "property_ref") return;
      const rstate = renderStateFor(tok, raw, ownEntries, resolver);
      ranges.push(
        Decoration.replace({
          widget: new PropertyRefWidget(rstate),
        }).range(node.from, node.to),
      );
    },
  });

  return ranges;
}

export function buildPropertyDecorations(state: EditorState): DecorationSet {
  return offActiveLine(state, collectPropertyRefs(state));
}

export const propertyRefField = decorationField({
  collect: collectPropertyRefs,
  effects: [propertyResolverUpdated],
  watch: [
    (s) => s.facet(propertyResolverFacet),
    (s) => s.facet(propertyRefsEnabledFacet),
  ],
});

export const propertyRefBaseTheme = EditorView.baseTheme({
  ".cm-md-propref": {
    color: "var(--c-accent)",
  },
  ".cm-md-propref-loading": {
    color: "var(--c-fg-muted)",
    fontStyle: "italic",
  },
  ".cm-md-propref-broken": {
    color: "var(--c-warning, var(--c-fg-muted))",
    textDecoration: "underline dashed",
  },
});

export const propertyRefExtension: Extension = [
  propertyRefField,
  propertyRefBaseTheme,
];
