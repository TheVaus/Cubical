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
