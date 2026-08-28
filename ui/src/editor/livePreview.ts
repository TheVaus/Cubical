import type { Extension } from "@codemirror/state";

import { livePreviewDecorations } from "./decorations";
import { embedBlockField, embedBaseTheme } from "./embed";
import {
  blockRenderers,
  blockRenderersBaseTheme,
  blockRenderersField,
} from "./blockRenderers";
import { calcBlockRenderer, calcBlockBaseTheme } from "./calcBlock";
import { csvBlockRenderer } from "./csvBlock";
import { dataviewBlockRenderer, dataviewBaseTheme } from "./dataview";
import { mathBlockRenderer, mathBaseTheme, mathEnabledFacet } from "./math";
import { displayMathField } from "./mathDollar";
import { equationField, equationBaseTheme, equationsEnabledFacet } from "./equation";
import {
  propertyRefField,
  propertyRefBaseTheme,
  propertyRefsEnabledFacet,
} from "./propertyRef";

export const livePreviewBundle: Extension = [
  livePreviewDecorations,
  embedBlockField,
  embedBaseTheme,
  blockRenderersField,
  blockRenderersBaseTheme,
  blockRenderers(
    dataviewBlockRenderer,
    csvBlockRenderer,
    mathBlockRenderer,
    calcBlockRenderer,
  ),
  dataviewBaseTheme,
  mathBaseTheme,
  displayMathField,
  propertyRefField,
  propertyRefBaseTheme,
  equationField,
  equationBaseTheme,
  calcBlockBaseTheme,
];

export interface LivePreviewPlugins {
  math: boolean;
  equations: boolean;
  propertyRefs: boolean;
}

export function livePreviewFor(
  rawSource: boolean,
  plugins: LivePreviewPlugins,
): Extension {
  return rawSource
    ? []
    : [
        livePreviewBundle,
        mathEnabledFacet.of(plugins.math),
        equationsEnabledFacet.of(plugins.equations),
        propertyRefsEnabledFacet.of(plugins.propertyRefs),
      ];
}
