import { createMemo } from "solid-js";

import { corePluginActive } from "../settings/corePlugins";
import { createDataviewRunner, type DataviewRunner } from "./dataview";

export const DATAVIEW_PLUGIN = "dataview";

export interface DataviewWiringDeps {
  vaultId: () => string | null;
  corePlugins: () => Record<string, boolean>;
  onOpen: (path: string) => void;
  create?: (
    vaultId: string,
    onOpen: (path: string) => void,
  ) => DataviewRunner;
}

export function createDataviewWiring(
  deps: DataviewWiringDeps,
): () => DataviewRunner | null {
  const make = deps.create ?? createDataviewRunner;
  return createMemo<DataviewRunner | null>(() => {
    const id = deps.vaultId();
    if (id === null) return null;
    if (!corePluginActive(deps.corePlugins(), DATAVIEW_PLUGIN)) return null;
    return make(id, deps.onOpen);
  });
}
