import { createSignal } from "solid-js";

import { listTags } from "../api/ipc";

export interface VaultTags {
  readonly tags: () => string[];
  readonly ensureLoaded: () => Promise<void>;
  readonly invalidate: () => void;
}

interface Loaded {
  readonly vaultId: string;
  readonly tags: string[];
  readonly stale: boolean;
}

export function createVaultTags(vaultId: () => string | null): VaultTags {
  const [loaded, setLoaded] = createSignal<Loaded | null>(null);
  let generation = 0;

  return {
    tags: () => {
      const l = loaded();
      return l !== null && l.vaultId === vaultId() ? l.tags : [];
    },
    ensureLoaded: async () => {
      const id = vaultId();
      const current = loaded();
      if (!id || (current?.vaultId === id && !current.stale)) return;
      const mine = ++generation;
      let tags: string[] = [];
      try {
        tags = (await listTags({ vault_id: id })).tags;
      } catch (e) {
        console.error("list_tags failed; Omni-Bar runs notes-only", e);
      }
      if (mine === generation && vaultId() === id) {
        setLoaded({ vaultId: id, tags, stale: false });
      }
    },
    invalidate: () => {
      generation += 1;
      setLoaded((l) => (l === null ? null : { ...l, stale: true }));
    },
  };
}
