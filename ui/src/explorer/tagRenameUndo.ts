export function canUndoTagRename(renameOpId: number): boolean {
  return renameOpId > 0;
}

export function undoResultMessage(removed: number): string {
  if (removed === 0) {
    return "Nothing to undo — the rewrites have already been applied.";
  }
  const plural = removed === 1 ? "" : "s";
  return `Undone — ${removed} pending rewrite${plural} dropped.`;
}
