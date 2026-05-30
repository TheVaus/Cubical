/**
 * Per-vault autocomplete adapter (L3 Session F, spec §2.6).
 *
 * Mirrors `createWikiLinkResolver`: one provider is bound to the open
 * vault and injected into the editor. It is a thin async wrapper over
 * the `link_autocomplete` / `tag_autocomplete` IPC. No caching — CM6's
 * `validFor` handles in-place filtering between keystrokes, and the
 * dropdown is short-lived, so each fresh trigger re-queries.
 */

import {
  blockIdAutocomplete as defaultBlockIdAutocomplete,
  linkAutocomplete as defaultLinkAutocomplete,
  tagAutocomplete as defaultTagAutocomplete,
  type BlockIdAutocompleteRequest,
  type BlockIdAutocompleteResponse,
  type LinkAutocompleteRequest,
  type LinkAutocompleteResponse,
  type LinkCandidate,
  type TagAutocompleteRequest,
  type TagAutocompleteResponse,
} from "../api/ipc";

export interface AutocompleteProvider {
  /** Files matching `query` (substring). Empty array on failure. */
  links: (query: string) => Promise<LinkCandidate[]>;
  /** Tags matching `query` (prefix). Empty array on failure. */
  tags: (query: string) => Promise<string[]>;
  /** Block ids in `target` (resolved server-side). Empty on failure. */
  blockIds: (target: string) => Promise<string[]>;
}

/**
 * Build a provider bound to one vault. `linkIpc` / `tagIpc` are injected
 * so tests can stub them; production passes the `api/ipc.ts` functions.
 * Failures resolve to an empty list so a transient IPC error just shows
 * no candidates rather than throwing into CM's completion pipeline.
 */
export function createAutocompleteProvider(
  vaultId: string,
  linkIpc: (
    req: LinkAutocompleteRequest,
  ) => Promise<LinkAutocompleteResponse> = defaultLinkAutocomplete,
  tagIpc: (
    req: TagAutocompleteRequest,
  ) => Promise<TagAutocompleteResponse> = defaultTagAutocomplete,
  blockIdIpc: (
    req: BlockIdAutocompleteRequest,
  ) => Promise<BlockIdAutocompleteResponse> = defaultBlockIdAutocomplete,
): AutocompleteProvider {
  return {
    async links(query) {
      try {
        const resp = await linkIpc({ vault_id: vaultId, query });
        return resp.candidates;
      } catch {
        return [];
      }
    },
    async tags(query) {
      try {
        const resp = await tagIpc({ vault_id: vaultId, query });
        return resp.candidates;
      } catch {
        return [];
      }
    },
    async blockIds(target) {
      try {
        const resp = await blockIdIpc({ vault_id: vaultId, target_raw: target });
        return resp.candidates;
      } catch {
        return [];
      }
    },
  };
}
