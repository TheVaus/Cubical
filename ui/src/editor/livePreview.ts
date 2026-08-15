import type { Extension } from "@codemirror/state";

import { livePreviewDecorations } from "./decorations";
import { embedBlockField, embedBaseTheme } from "./embed";
import {
  blockRenderers,
  blockRenderersBaseTheme,
  blockRenderersField,
} from "./blockRenderers";
import { csvBlockRenderer } from "./csvBlock";
import { dataviewBlockRenderer, dataviewBaseTheme } from "./dataview";
import { propertyRefField, propertyRefBaseTheme } from "./propertyRef";

export const livePreviewBundle: Extension = [
  livePreviewDecorations,
  embedBlockField,
  embedBaseTheme,
  blockRenderersField,
  blockRenderersBaseTheme,
  blockRenderers(dataviewBlockRenderer, csvBlockRenderer),
  dataviewBaseTheme,
  propertyRefField,
  propertyRefBaseTheme,
];
