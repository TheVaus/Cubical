/**
 * Live Preview bundle — Contract 1 of L4-A-fix (spec §3.1).
 *
 * THIS is the single composed extension that `Editor.tsx` installs
 * inside `decorationCompartment`. Raw-source mode reconfigures the
 * compartment to `[]` and structurally kills every transformation
 * in the bundle.
 *
 * **Contract:** every editor transformation that should disappear in
 * raw-source mode MUST be a member of this bundle. Adding a
 * preview-only extension elsewhere (the base extension list of the
 * editor state, or a separate compartment) is a bug — raw-source
 * mode will not kill it, and the L4-A bug #4 class returns.
 *
 * Members:
 *   - `livePreviewDecorations` (decorations.ts) — heading/em/strong/
 *     code/list/blockquote/link/wikilink/tag/blockid line + mark
 *     decorations, frontmatter block-replace, and the resolver
 *     fetch-kick ViewPlugin.
 *   - `embedBlockField` + `embedBaseTheme` (embed.ts) — the embed
 *     `![[…]]` block-replace decorations and their base CSS.
 *
 * Future preview-only extensions (e.g. L4-B's editor-side search-hit
 * highlight) join this list, not the base extension list of
 * `Editor.tsx`.
 */

import type { Extension } from "@codemirror/state";

import { livePreviewDecorations } from "./decorations";
import { embedBlockField, embedBaseTheme } from "./embed";

export const livePreviewBundle: Extension = [
  livePreviewDecorations,
  embedBlockField,
  embedBaseTheme,
];
