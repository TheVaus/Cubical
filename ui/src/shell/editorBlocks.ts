import type { Extension } from "@codemirror/state";

import { renderDataview } from "../dataview/dataviewRender";
import { blockRenderers } from "../editor/blockRenderers";
import { calcBlockBaseTheme, calcBlockRenderer } from "../editor/calcBlock";
import { csvBlockRenderer } from "../editor/csvBlock";
import { dataviewBaseTheme, dataviewBlockRenderer } from "../editor/dataview";
import { embedBaseTheme, embedBlockField, embedFileRendererFacet } from "../editor/embed";
import type { EmbeddedFile } from "../editor/embedRender";
import {
  equationBaseTheme,
  equationField,
  equationsEnabledFacet,
} from "../editor/equation";
import { mathBaseTheme, mathBlockRenderer, mathEnabledFacet } from "../editor/math";
import { displayMathField } from "../editor/mathDollar";
import {
  propertyRefBaseTheme,
  propertyRefField,
  propertyRefsEnabledFacet,
} from "../editor/propertyRef";
import { renderViewerPayload } from "../viewer/FileViewer";
import { renderDelimitedTable } from "../viewer/render";
import { viewerKindForPath } from "../viewer/viewerKind";

export function renderEmbeddedFile(file: EmbeddedFile): Node {
  return renderViewerPayload(
    { kind: viewerKindForPath(file.path), mime: file.mime, base64: file.base64 },
    file.path,
  );
}

export const editorBlocks: Extension = [
  blockRenderers(
    dataviewBlockRenderer(renderDataview),
    csvBlockRenderer(renderDelimitedTable),
    mathBlockRenderer,
    calcBlockRenderer,
  ),
  embedBlockField,
  embedBaseTheme,
  dataviewBaseTheme,
  mathBaseTheme,
  displayMathField,
  propertyRefField,
  propertyRefBaseTheme,
  equationField,
  equationBaseTheme,
  calcBlockBaseTheme,
  embedFileRendererFacet.of(renderEmbeddedFile),
];

export interface PreviewToggles {
  mathEnabled?: boolean;
  equationsEnabled?: boolean;
  propertyRefsEnabled?: boolean;
}

export const previewToggles: Record<
  keyof PreviewToggles,
  (on: boolean) => Extension
> = {
  mathEnabled: (on) => mathEnabledFacet.of(on),
  equationsEnabled: (on) => equationsEnabledFacet.of(on),
  propertyRefsEnabled: (on) => propertyRefsEnabledFacet.of(on),
};
