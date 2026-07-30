export interface History {
  entries: string[];
  cursor: number;
}

export const emptyHistory: History = { entries: [], cursor: 0 };

export function push(h: History, line: string): History {
  const trimmed = line.trim();
  if (trimmed === "" || h.entries[h.entries.length - 1] === trimmed) {
    return { entries: h.entries, cursor: h.entries.length };
  }
  const entries = [...h.entries, trimmed];
  return { entries, cursor: entries.length };
}

export function up(h: History): { history: History; value: string | null } {
  if (h.entries.length === 0) return { history: h, value: null };
  const cursor = Math.max(0, h.cursor - 1);
  return { history: { ...h, cursor }, value: h.entries[cursor] ?? null };
}

export function down(h: History): { history: History; value: string | null } {
  if (h.cursor >= h.entries.length) return { history: h, value: null };
  const cursor = h.cursor + 1;
  const value = cursor >= h.entries.length ? null : (h.entries[cursor] ?? null);
  return { history: { ...h, cursor }, value };
}
