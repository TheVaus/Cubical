import type { Extension } from "@codemirror/state";

import { renderDataview } from "../dataview/dataviewRender";
import { blockRenderers } from "../editor/blockRenderers";
import { csvBlockRenderer } from "../editor/csvBlock";
import { dataviewBlockRenderer } from "../editor/dataview";
import { embedFileRendererFacet } from "../editor/embed";
import type { EmbeddedFile } from "../editor/embedRender";
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
  ),
  embedFileRendererFacet.of(renderEmbeddedFile),
];
