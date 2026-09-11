import { invoke } from "./transport";

export interface CreateBlockRefRequest {
  vault_id: string;
  target_path: string;
  position: number;
}

export interface CreateBlockRefResponse {
  block_id: string;
}

export interface GetBrokenBlockRefsRequest {
  vault_id: string;
}

export interface BrokenBlockRef {
  source_file_path: string;
  target_file_path: string;
  target_block_id: string;
}

export interface GetBrokenBlockRefsResponse {
  refs: BrokenBlockRef[];
}

export function createBlockRef(
  req: CreateBlockRefRequest,
): Promise<CreateBlockRefResponse> {
  return invoke("create_block_ref", { req });
}

export function getBrokenBlockRefs(
  req: GetBrokenBlockRefsRequest,
): Promise<GetBrokenBlockRefsResponse> {
  return invoke("get_broken_block_refs", { req });
}
