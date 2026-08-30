import {
  getEmbed as defaultGetEmbed,
  type GetEmbedRequest,
  type GetEmbedResponse,
} from "../api/ipc";
import { createKeyedResolver, type KeyedResolver } from "./keyedResolver";

export type { ResolverDebugState, ResolverEvent } from "./keyedResolver";

export type EmbedResolution = GetEmbedResponse;

export type EmbedResolver = KeyedResolver<string, EmbedResolution>;

const UNRESOLVED: EmbedResolution = {
  kind: "unresolved",
  target_path: null,
  content: null,
};

export function createEmbedResolver(
  vaultId: string,
  ipc: (req: GetEmbedRequest) => Promise<GetEmbedResponse> = defaultGetEmbed,
): EmbedResolver {
  return createKeyedResolver<string, EmbedResolution>({
    cacheKey: (targetRaw) => targetRaw,
    load: (targetRaw) => ipc({ vault_id: vaultId, target_raw: targetRaw }),
    onFailure: () => UNRESOLVED,
  });
}
