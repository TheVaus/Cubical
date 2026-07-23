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
  links: (query: string) => Promise<LinkCandidate[]>;
  tags: (query: string) => Promise<string[]>;
  blockIds: (target: string) => Promise<string[]>;
}

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
