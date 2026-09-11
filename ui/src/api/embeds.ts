import { invoke } from "./transport";

export interface GetEmbedRequest {
  vault_id: string;
  target_raw: string;
}

export type EmbedKind =
  | "note"
  | "section"
  | "block"
  | "file"
  | "unresolved"
  | "missing-anchor";

export interface GetEmbedResponse {
  kind: EmbedKind;
  target_path: string | null;
  content: string | null;
  mime?: string | null;
}

export function getEmbed(req: GetEmbedRequest): Promise<GetEmbedResponse> {
  return invoke("get_embed", { req });
}
