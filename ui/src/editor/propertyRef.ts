/**
 * Live-Preview inline widget for property references
 * (`[[note.prop]]` / `[[.prop]]`, property-reference-interpolation design).
 *
 * Walks the Lezer tree for every `WikiLink` node whose raw source the
 * tokenizer classifies as a `property_ref`, and replaces the token with
 * an INLINE widget rendering the resolved frontmatter scalar (read-only).
 *
 * Resolution:
 *   - Self-ref (`note === null`) reads the open document's own frontmatter
 *     synchronously — no IPC.
 *   - Cross-file ref goes through the {@link PropertyResolver} cache; a
 *     cold lookup renders a `loading` placeholder and kicks a fetch, and a
 *     `propertyResolverUpdated` effect rebuilds when the cache settles.
 *
 * Cursor-line suppression: when the cursor sits on the token's line, the
 * raw `[[…]]` text stays visible for editing — the established Live
 * Preview pattern (Link / Emphasis / embed). The replace ranges are
 * registered ATOMIC so cursor motion steps over a rendered value cleanly
 * everywhere else.
 */

import {
  Decoration,
  EditorView,
  WidgetType,
  type DecorationSet,
} from "@codemirror/view";
import {
  Facet,
  StateEffect,
  StateField,
  type EditorState,
  type Extension,
  type Range,
} from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";

import { scanWikilinks } from "../ast/wikilink";
import { splitFrontmatter, parseFrontmatterYaml } from "../ast/frontmatter";
import type { PropertyResolver } from "./propertyResolver";
import {
  renderPropertyRef,
  type PropertyRefRenderState,
} from "./propertyRefRender";

/**
 * Per-editor property resolver supplied via {@link propertyResolverFacet}.
 * `null` when no vault is open — cross-file refs then render as broken,
 * self-refs still resolve from the open document.
 */
export const propertyResolverFacet = Facet.define<
  PropertyResolver | null,
  PropertyResolver | null
>({
  combine: (values) => values[0] ?? null,
});

/**
 * StateEffect dispatched by `Editor.tsx` whenever the resolver's cache
 * changes; the field watches transactions for it and rebuilds.
 */
export const propertyResolverUpdated = StateEffect.define<null>();

/** Render a single top-level frontmatter scalar to display text. */
function scalarToDisplay(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    const parts = value.filter(
      (v) =>
        typeof v === "string" ||
        typeof v === "number" ||
        typeof v === "boolean",
    );
    return parts.length ? parts.map(String).join(", ") : null;
  }
  return null;
}

/** Look up a top-level key in the open doc's own frontmatter (self-ref). */
function selfValue(docText: string, property: string): string | null {
  const split = splitFrontmatter(docText);
  if (split.yaml === null || split.span === null) return null;
  const fm = parseFrontmatterYaml(split.yaml, split.span);
  const entry = fm?.entries.find(([k]) => k === property);
  return entry ? scalarToDisplay(entry[1]) : null;
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

  // Let click events bubble to the capture-phase mousedown handler in
  // Editor.tsx (so a click on a rendered value can route to its source).
  override ignoreEvent(): boolean {
    return false;
  }
}

/** Resolve the render state for one tokenized property-ref run. */
function renderStateFor(
  tok: { note: string | null; property: string },
  raw: string,
  docText: string,
  resolver: PropertyResolver | null,
): PropertyRefRenderState {
  if (tok.note === null) {
    const v = selfValue(docText, tok.property);
    return v === null ? { status: "broken", raw } : { status: "resolved", value: v };
  }
  const hit = resolver?.get(tok.note, tok.property);
  if (!hit) {
    resolver?.fetch(tok.note, tok.property);
    return { status: "loading", raw };
  }
  if (hit.kind === "resolved" && hit.value !== null) {
    return { status: "resolved", value: hit.value };
  }
  return { status: "broken", raw };
}

export function buildPropertyDecorations(state: EditorState): DecorationSet {
  const resolver = state.facet(propertyResolverFacet);
  const tree = syntaxTree(state);
  const doc = state.doc;
  const docText = doc.toString();
  const activeLine = doc.lineAt(state.selection.main.head).number;
  const ranges: Range<Decoration>[] = [];

  tree.iterate({
    enter: (node) => {
      if (node.name !== "WikiLink") return;
      const raw = doc.sliceString(node.from, node.to);
      const tok = scanWikilinks(raw)[0];
      if (!tok || tok.kind !== "property_ref") return;
      // Cursor-line suppression: expose the raw token for editing.
      if (doc.lineAt(node.from).number === activeLine) return;
      const rstate = renderStateFor(tok, raw, docText, resolver);
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

export const propertyRefField = StateField.define<DecorationSet>({
  create: (state) => buildPropertyDecorations(state),
  update: (deco, tr) => {
    const resolverChanged = tr.effects.some((e) =>
      e.is(propertyResolverUpdated),
    );
    const treeChanged = syntaxTree(tr.startState) !== syntaxTree(tr.state);
    const facetChanged =
      tr.startState.facet(propertyResolverFacet) !==
      tr.state.facet(propertyResolverFacet);
    const activeLineChanged =
      tr.startState.doc.lineAt(tr.startState.selection.main.head).number !==
      tr.state.doc.lineAt(tr.state.selection.main.head).number;
    if (
      !tr.docChanged &&
      !treeChanged &&
      !resolverChanged &&
      !facetChanged &&
      !activeLineChanged
    ) {
      return deco;
    }
    return buildPropertyDecorations(tr.state);
  },
  provide: (f) => [
    EditorView.decorations.from(f),
    EditorView.atomicRanges.of(
      (view) => view.state.field(f, false) ?? Decoration.none,
    ),
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
