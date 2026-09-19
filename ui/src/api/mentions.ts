import { invoke } from "./transport";

export interface GetUnlinkedMentionsRequest {
  vault_id: string;
  path: string;
}

export interface Mention {
  source_path: string;
  context: string;
  position: number;
  byte_len: number;
  needle: string;
}

export interface GetUnlinkedMentionsResponse {
  mentions: Mention[];
}

export interface LinkMentionRequest {
  vault_id: string;
  source_path: string;
  position: number;
  byte_len: number;
  target_title: string;
  needle?: string;
}

export interface LinkMentionResponse {
  new_hash: string;
}

export function getUnlinkedMentions(
  req: GetUnlinkedMentionsRequest,
): Promise<GetUnlinkedMentionsResponse> {
  return invoke("get_unlinked_mentions", { req });
}

export function linkMention(
  req: LinkMentionRequest,
): Promise<LinkMentionResponse> {
  return invoke("link_mention", { req });
}
