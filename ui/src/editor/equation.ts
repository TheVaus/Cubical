import {
  Decoration,
  EditorView,
  WidgetType,
  type DecorationSet,
} from "@codemirror/view";
import {
  Facet,
  StateField,
  type EditorState,
  type Extension,
  type Range,
} from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";

import { inferType, type CellKind } from "../properties/inferType";
import { evaluate, type RefResolution, type ResolveRef } from "./expr/evaluate";
import { formatResult } from "./expr/format";
import {
  renderEquation,
  type EquationRenderState,
} from "./equationRender";
import {
  frontmatterEntries,
  propertyResolverFacet,
  propertyResolverUpdated,
} from "./propertyRef";
import type { PropertyResolver } from "./propertyResolver";

export const equationsEnabledFacet = Facet.define<boolean, boolean>({
  combine: (values) => values[0] ?? true,
});

export const EQUATION_PREFIX = "=";

const NUMERIC: ReadonlySet<CellKind> = new Set<CellKind>([
  "int",
  "float",
  "currency",
]);

export function numericOperand(value: unknown): RefResolution {
  if (!NUMERIC.has(inferType(value)) || typeof value !== "number") {
    return { kind: "not_a_number" };
  }
  return Number.isFinite(value)
    ? { kind: "number", value }
    : { kind: "not_a_number" };
}

export function equationSource(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith(EQUATION_PREFIX)) return null;
  const body = trimmed.slice(EQUATION_PREFIX.length).trim();
  return body.length === 0 ? null : body;
}

export function makeRefResolver(
  resolver: PropertyResolver | null,
  getDocText: () => string,
): ResolveRef {
  let own: Map<string, unknown> | undefined;
  const ownEntries = () => (own ??= frontmatterEntries(getDocText()));
  return (note, property) => {
    if (note === null) {
      const entries = ownEntries();
      return entries.has(property)
        ? numericOperand(entries.get(property))
        : { kind: "missing_property" };
    }
    const hit = resolver?.get(note, property);
    if (!hit) {
      resolver?.fetch(note, property);
      return { kind: "loading" };
    }
    if (hit.kind === "note_unresolved") return { kind: "unresolved_note" };
    if (hit.kind === "property_missing") return { kind: "missing_property" };
    return numericOperand(hit.value);
  };
}

export function equationRenderState(
  source: string,
  resolve: ResolveRef,
): EquationRenderState | null {
  const outcome = evaluate(source, resolve);
  if (outcome.status === "ok") {
    return { status: "ok", value: formatResult(outcome.value) };
  }
  if (outcome.status === "loading") return { status: "loading", raw: source };
  if (outcome.kind === "syntax" || outcome.kind === "too_complex") return null;
  return { status: "error", kind: outcome.kind, raw: source };
}

class EquationWidget extends WidgetType {
  constructor(private readonly render: EquationRenderState) {
    super();
  }

  override toDOM(): HTMLElement {
    return renderEquation(this.render);
  }

  override eq(other: EquationWidget): boolean {
    return JSON.stringify(this.render) === JSON.stringify(other.render);
  }

  override ignoreEvent(): boolean {
    return false;
  }
}

function buildEquationDecorations(state: EditorState): DecorationSet {
  if (!state.facet(equationsEnabledFacet)) return Decoration.none;
  const doc = state.doc;
  const resolver = state.facet(propertyResolverFacet);
  let docText: string | undefined;
  const getDocText = () => (docText ??= doc.toString());
  const resolve = makeRefResolver(resolver, getDocText);
  const activeLine = doc.lineAt(state.selection.main.head).number;
  const ranges: Range<Decoration>[] = [];

  syntaxTree(state).iterate({
    enter: (node) => {
      if (node.name !== "InlineCode") return;
      if (doc.lineAt(node.from).number === activeLine) return;
      const marks = node.node.getChildren("CodeMark");
      const first = marks[0];
      const last = marks[marks.length - 1];
      const from = first ? first.to : node.from;
      const to = last && marks.length > 1 ? last.from : node.to;
      if (to <= from) return;
      const source = equationSource(doc.sliceString(from, to));
      if (source === null) return;
      const render = equationRenderState(source, resolve);
      if (render === null) return;
      ranges.push(
        Decoration.replace({ widget: new EquationWidget(render) }).range(
          node.from,
          node.to,
        ),
      );
    },
  });

  ranges.sort((a, b) => a.from - b.from);
  return Decoration.set(ranges, true);
}

export const equationField = StateField.define<DecorationSet>({
  create: (state) => buildEquationDecorations(state),
  update: (deco, tr) => {
    const resolverChanged = tr.effects.some((e) =>
      e.is(propertyResolverUpdated),
    );
    const treeChanged = syntaxTree(tr.startState) !== syntaxTree(tr.state);
    const facetChanged =
      tr.startState.facet(propertyResolverFacet) !==
        tr.state.facet(propertyResolverFacet) ||
      tr.startState.facet(equationsEnabledFacet) !==
        tr.state.facet(equationsEnabledFacet);
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
    return buildEquationDecorations(tr.state);
  },
  provide: (f) => [
    EditorView.decorations.from(f),
    EditorView.atomicRanges.of(
      (view) => view.state.field(f, false) ?? Decoration.none,
    ),
  ],
});

export const equationBaseTheme = EditorView.baseTheme({
  ".cm-equation": {
    color: "var(--c-accent)",
  },
  ".cm-equation-loading": {
    color: "var(--c-fg-muted)",
    fontStyle: "italic",
  },
  ".cm-equation-error": {
    color: "var(--c-warning, var(--c-fg-muted))",
    textDecoration: "underline dashed",
  },
});

export const equationExtension: Extension = [equationField, equationBaseTheme];
