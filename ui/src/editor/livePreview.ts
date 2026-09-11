import type { Extension } from "@codemirror/state";

import { livePreviewDecorations } from "./decorations";
import { blockRenderersBaseTheme, blockRenderersField } from "./blockRenderers";
import { renderFailureBaseTheme } from "./widgetGuard";

export const livePreviewBundle: Extension = [
  livePreviewDecorations,
  blockRenderersField,
  blockRenderersBaseTheme,
];

export interface LivePreviewPlugins {
  math: boolean;
  equations: boolean;
  propertyRefs: boolean;
}

export type PreviewBlocks = (plugins: LivePreviewPlugins) => Extension;

export function livePreviewFor(
  rawSource: boolean,
  plugins: LivePreviewPlugins,
  blocks?: PreviewBlocks,
): Extension {
  return rawSource
    ? []
    : [livePreviewBundle, blocks ? blocks(plugins) : [], renderFailureBaseTheme];
}
