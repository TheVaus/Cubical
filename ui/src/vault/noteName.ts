/**
 * Note-name validation for the property-reference feature.
 *
 * A note whose filename contains a `.` (before the `.md` extension) is not
 * reachable by a plain `[[ ]]` link, because the dot is the property-ref
 * separator (`[[note.prop]]`). Cubical can't prevent such files from
 * existing on disk (external tools), but its own create/rename flows
 * refuse to author new ones, and the tree flags any that already exist.
 * See the property-reference-interpolation design §5.
 */

/** True when `name` is safe to use as a `[[ ]]`-linkable note name. */
export function isValidNoteName(name: string): boolean {
  const base = name.endsWith(".md") ? name.slice(0, -3) : name;
  return base.length > 0 && !base.includes(".");
}

/** Human-readable reason a name was rejected by {@link isValidNoteName}. */
export function noteNameError(name: string): string {
  return `"${name}" can't contain a dot — dots are reserved for property references like [[note.prop]].`;
}
