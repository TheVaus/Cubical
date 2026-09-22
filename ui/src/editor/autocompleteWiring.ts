import { createMemo } from "solid-js";

import { corePluginActive } from "../settings/corePlugins";
import {
  createAutocompleteProvider,
  type AutocompleteProvider,
} from "./autocompleteProvider";
import { AUTOCOMPLETE_PLUGIN } from "./autocompleteRegistration";

export interface AutocompleteWiringDeps {
  vaultId: () => string | null;
  corePlugins: () => Record<string, boolean>;
  create?: (vaultId: string) => AutocompleteProvider;
}

export function createAutocompleteWiring(
  deps: AutocompleteWiringDeps,
): () => AutocompleteProvider | null {
  const make = deps.create ?? createAutocompleteProvider;
  return createMemo<AutocompleteProvider | null>(() => {
    const id = deps.vaultId();
    if (id === null) return null;
    if (!corePluginActive(deps.corePlugins(), AUTOCOMPLETE_PLUGIN)) return null;
    return make(id);
  });
}
