/**
 * Decision helper for the `vault:file-changed` handler in `App.tsx`.
 *
 * Returns true iff the incoming change event is the *open* file's own
 * autosave write echoing back through the OS file watcher — i.e. the
 * changed path is the open file, the event carries a content hash, and
 * that hash equals the hash of our most recent successful write.
 *
 * Used to skip embed / wiki-link resolver invalidation on own writes:
 * an own write to the open file cannot have changed any *other* file's
 * content, so cached resolutions stay valid, and a needless invalidate
 * only thrashes embed-card height (the L4-A-fix viewport-jump bug,
 * `docs/layer-4-spec.md` §9.2). External edits and other-file changes
 * return false, so they still invalidate.
 */
export function isOwnWriteEcho(p: {
  changedPath: string;
  selectedPath: string | null;
  incomingHash: string | null | undefined;
  lastWrittenHash: string | null;
}): boolean {
  if (p.selectedPath === null) return false;
  if (p.changedPath !== p.selectedPath) return false;
  if (!p.incomingHash) return false;
  return p.incomingHash === p.lastWrittenHash;
}
