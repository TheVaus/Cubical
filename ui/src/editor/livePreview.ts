import type { Extension } from "@codemirror/state";

import { livePreviewDecorations } from "./decorations";
import { blockRenderersBaseTheme, blockRenderersField } from "./blockRenderers";
import { renderFailureBaseTheme } from "./widgetGuard";

export const livePreviewBundle: Extension = [
  livePreviewDecorations,
  blockRenderersField,
  blockRenderersBaseTheme,
];

export function livePreviewFor(
  rawSource: boolean,
  blocks: Extension = [],
): Extension {
  return rawSource ? [] : [livePreviewBundle, blocks, renderFailureBaseTheme];
}
