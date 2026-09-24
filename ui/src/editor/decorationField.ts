import { Decoration, EditorView, type DecorationSet } from "@codemirror/view";
import {
  StateField,
  type EditorState,
  type Range,
  type StateEffectType,
  type Transaction,
} from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";

export interface DecorationFieldSpec {
  collect: (state: EditorState) => readonly Range<Decoration>[];
  effects?: readonly StateEffectType<null>[];
  watch?: readonly ((state: EditorState) => unknown)[];
}

export interface CollectedDecorations {
  ranges: readonly Range<Decoration>[];
  activeLine: number;
  deco: DecorationSet;
}

const activeLine = (state: EditorState): number =>
  state.doc.lineAt(state.selection.main.head).number;

export function offActiveLine(
  state: EditorState,
  ranges: readonly Range<Decoration>[],
): DecorationSet {
  const doc = state.doc;
  const line = activeLine(state);
  const kept = ranges.filter(
    (r) =>
      line < doc.lineAt(r.from).number || line > doc.lineAt(r.to).number,
  );
  return Decoration.set(kept, true);
}

export function decorationsAreStale(
  spec: DecorationFieldSpec,
  tr: Transaction,
): boolean {
  if (tr.docChanged) return true;
  if (syntaxTree(tr.startState) !== syntaxTree(tr.state)) return true;
  if (spec.effects?.some((kind) => tr.effects.some((e) => e.is(kind)))) {
    return true;
  }
  return (
    spec.watch?.some((read) => read(tr.startState) !== read(tr.state)) ?? false
  );
}

function collected(
  spec: DecorationFieldSpec,
  state: EditorState,
): CollectedDecorations {
  const ranges = spec.collect(state);
  return {
    ranges,
    activeLine: activeLine(state),
    deco: offActiveLine(state, ranges),
  };
}

export function decorationField(
  spec: DecorationFieldSpec,
): StateField<CollectedDecorations> {
  return StateField.define<CollectedDecorations>({
    create: (state) => collected(spec, state),
    update: (prev, tr) => {
      if (decorationsAreStale(spec, tr)) return collected(spec, tr.state);
      const line = activeLine(tr.state);
      if (line === prev.activeLine) return prev;
      return {
        ranges: prev.ranges,
        activeLine: line,
        deco: offActiveLine(tr.state, prev.ranges),
      };
    },
    provide: (f) => [
      EditorView.decorations.from(f, (v) => v.deco),
      EditorView.atomicRanges.of(
        (view) => view.state.field(f, false)?.deco ?? Decoration.none,
      ),
    ],
  });
}
