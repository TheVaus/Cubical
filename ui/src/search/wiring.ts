import { createMemo, untrack } from "solid-js";

import { corePluginActive } from "../settings/corePlugins";
import { SEARCH_PLUGIN } from "./registration";
import {
  createSearchState,
  type SearchState,
  type SearchStateDeps,
} from "./searchState";

export interface SearchWiringDeps extends SearchStateDeps {
  corePlugins: () => Record<string, boolean>;
  create?: (deps: SearchStateDeps) => SearchState;
}

export function createSearchWiring(
  deps: SearchWiringDeps,
): () => SearchState | null {
  const make = deps.create ?? createSearchState;
  const enabled = createMemo(() =>
    corePluginActive(deps.corePlugins(), SEARCH_PLUGIN),
  );
  return createMemo<SearchState | null>(() =>
    enabled() ? untrack(() => make(deps)) : null,
  );
}
