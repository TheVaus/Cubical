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
import { mathBlockRenderer, mathBaseTheme, mathEnabledFacet } from "./math";
import { displayMathField } from "./mathDollar";
import { propertyRefField, propertyRefBaseTheme } from "./propertyRef";

export const livePreviewBundle: Extension = [
  livePreviewDecorations,
  embedBlockField,
  embedBaseTheme,
  blockRenderersField,
  blockRenderersBaseTheme,
  blockRenderers(dataviewBlockRenderer, csvBlockRenderer, mathBlockRenderer),
  dataviewBaseTheme,
  mathBaseTheme,
  displayMathField,
  propertyRefField,
  propertyRefBaseTheme,
];

export function livePreviewFor(
  rawSource: boolean,
  mathEnabled: boolean,
): Extension {
  return rawSource
    ? []
    : [livePreviewBundle, mathEnabledFacet.of(mathEnabled)];
}
