import {
  Decoration,
  EditorView,
  WidgetType,
  type DecorationSet,
} from "@codemirror/view";
import {
  Facet,
  StateEffect,
  type EditorState,
  type Extension,
  type Range,
} from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";

import { scanWikilinks } from "../ast/wikilink";
import { splitFrontmatter, parseFrontmatterYaml } from "../ast/frontmatter";
import { decorationField } from "./decorationField";
import type { PropertyResolver } from "./propertyResolver";
import {
  renderPropertyRef,
  type PropertyRefRenderState,
} from "./propertyRefRender";

export const propertyResolverFacet = Facet.define<
  PropertyResolver | null,
  PropertyResolver | null
>({
  combine: (values) => values[0] ?? null,
});

export const propertyRefsEnabledFacet = Facet.define<boolean, boolean>({
  combine: (values) => values[0] ?? true,
});

export const propertyResolverUpdated = StateEffect.define<null>();

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

function selfValue(docText: string, property: string): string | null {
  const value = selfPropertyValue(docText, property);
  return value === undefined ? null : scalarToDisplay(value);
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
  getDocText: () => string,
  resolver: PropertyResolver | null,
): PropertyRefRenderState {
  if (tok.note === null) {
    const v = selfValue(getDocText(), tok.property);
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

export function buildPropertyDecorations(state: EditorState): DecorationSet {
  if (!state.facet(propertyRefsEnabledFacet)) return Decoration.none;
  const resolver = state.facet(propertyResolverFacet);
  const tree = syntaxTree(state);
  const doc = state.doc;
  let docText: string | undefined;
  const getDocText = () => (docText ??= doc.toString());
  const activeLine = doc.lineAt(state.selection.main.head).number;
  const ranges: Range<Decoration>[] = [];

  tree.iterate({
    enter: (node) => {
      if (node.name !== "WikiLink") return;
      const raw = doc.sliceString(node.from, node.to);
      const tok = scanWikilinks(raw)[0];
      if (!tok || tok.kind !== "property_ref") return;
      if (doc.lineAt(node.from).number === activeLine) return;
      const rstate = renderStateFor(tok, raw, getDocText, resolver);
      ranges.push(
        Decoration.replace({
          widget: new PropertyRefWidget(rstate),
        }).range(node.from, node.to),
      );
    },
  });

  ranges.sort((a, b) => a.from - b.from);
  return Decoration.set(ranges, true);
}

export const propertyRefField = decorationField({
  build: buildPropertyDecorations,
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
