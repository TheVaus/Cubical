import type { Extension } from "@codemirror/state";

import { livePreviewDecorations } from "./decorations";
import { embedBlockField, embedBaseTheme } from "./embed";
import { csvBlockBaseTheme, csvBlockField } from "./csvBlock";
import { dataviewBlockField, dataviewBaseTheme } from "./dataview";
import { propertyRefField, propertyRefBaseTheme } from "./propertyRef";

export const livePreviewBundle: Extension = [
  livePreviewDecorations,
  embedBlockField,
  embedBaseTheme,
  dataviewBlockField,
  dataviewBaseTheme,
  csvBlockField,
  csvBlockBaseTheme,
  propertyRefField,
  propertyRefBaseTheme,
];
