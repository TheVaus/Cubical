import { createSignal } from "solid-js";

export interface SurfaceErrors {
  readonly banner: () => string | null;
  readonly vaultFailed: (message: string) => void;
  readonly vaultOpened: () => void;
  readonly tabFailed: (tabId: string, message: string) => void;
  readonly tabLoaded: (tabId: string) => void;
  readonly clear: () => void;
}

interface TabFailure {
  readonly tabId: string;
  readonly message: string;
}

export function createSurfaceErrors(
  activeTabId: () => string | null,
): SurfaceErrors {
  const [vault, setVault] = createSignal<string | null>(null);
  const [tab, setTab] = createSignal<TabFailure | null>(null);

  return {
    banner: () => {
      const v = vault();
      if (v !== null) return v;
      const t = tab();
      return t !== null && t.tabId === activeTabId() ? t.message : null;
    },
    vaultFailed: (message) => setVault(message),
    vaultOpened: () => setVault(null),
    tabFailed: (tabId, message) => setTab({ tabId, message }),
    tabLoaded: (tabId) => setTab((t) => (t?.tabId === tabId ? null : t)),
    clear: () => {
      setVault(null);
      setTab(null);
    },
  };
}
