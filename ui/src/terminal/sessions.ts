export interface TerminalSessions {
  register: (tabId: string, terminalId: string) => void;
  forget: (tabId: string) => void;
  idFor: (tabId: string) => string | null;
  size: () => number;
}

export function createTerminalSessions(): TerminalSessions {
  const ids = new Map<string, string>();
  return {
    register: (tabId, terminalId) => {
      ids.set(tabId, terminalId);
    },
    forget: (tabId) => {
      ids.delete(tabId);
    },
    idFor: (tabId) => ids.get(tabId) ?? null,
    size: () => ids.size,
  };
}
