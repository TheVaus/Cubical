import {
  resolveLink as defaultResolveLink,
  type ResolveLinkRequest,
  type ResolveLinkResponse,
} from "../api/ipc";
import {
  createKeyedResolver,
  type ResolverDebugState,
  type ResolverEvent,
} from "./keyedResolver";

export interface WikiLinkResolution {
  target_path: string | null;
  anchor: ResolveLinkResponse["anchor"];
}

export interface WikiLinkResolver {
  get(targetRaw: string): WikiLinkResolution | undefined;
  fetch(targetRaw: string): void;
  resolve(targetRaw: string): Promise<WikiLinkResolution>;
  invalidate(): void;
  markStale(): void;
  onUpdate(handler: () => void): () => void;
  debug(): ResolverDebugState;
  onEvent(handler: (e: ResolverEvent) => void): () => void;
  abort(): void;
}

const UNRESOLVED: WikiLinkResolution = { target_path: null, anchor: null };

export function createWikiLinkResolver(
  vaultId: string,
  ipc: (
    req: ResolveLinkRequest,
  ) => Promise<ResolveLinkResponse> = defaultResolveLink,
): WikiLinkResolver {
  return createKeyedResolver<string, WikiLinkResolution>({
    cacheKey: (targetRaw) => targetRaw,
    load: (targetRaw) =>
      ipc({ vault_id: vaultId, target_raw: targetRaw }).then((resp) => ({
        target_path: resp.target_path,
        anchor: resp.anchor,
      })),
    onFailure: () => UNRESOLVED,
  });
}
