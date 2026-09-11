import { invoke } from "./transport";

export interface LinkAutocompleteRequest {
  vault_id: string;
  query: string;
}

export interface LinkCandidate {
  path: string;
  title: string;
}

export interface LinkAutocompleteResponse {
  candidates: LinkCandidate[];
}

export interface TagAutocompleteRequest {
  vault_id: string;
  query: string;
}

export interface TagAutocompleteResponse {
  candidates: string[];
}

export function linkAutocomplete(
  req: LinkAutocompleteRequest,
): Promise<LinkAutocompleteResponse> {
  return invoke("link_autocomplete", { req });
}

export function tagAutocomplete(
  req: TagAutocompleteRequest,
): Promise<TagAutocompleteResponse> {
  return invoke("tag_autocomplete", { req });
}

export interface BlockIdAutocompleteRequest {
  vault_id: string;
  target_raw: string;
}

export interface BlockIdAutocompleteResponse {
  candidates: string[];
}

export function blockIdAutocomplete(
  req: BlockIdAutocompleteRequest,
): Promise<BlockIdAutocompleteResponse> {
  return invoke("block_id_autocomplete", { req });
}
