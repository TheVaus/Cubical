import type { DataviewRunner } from "./dataview";
import type { EmbedResolver } from "./embedResolver";
import type { PropertyResolver } from "./propertyResolver";
import type { WikiLinkResolver } from "./wikilinkResolver";

export interface ResolverGroup {
  wikilink: WikiLinkResolver | null;
  embed: EmbedResolver | null;
  property: PropertyResolver | null;
  dataview: DataviewRunner | null;
}

export function resetResolvers(group: ResolverGroup): void {
  group.wikilink?.invalidate();
  group.embed?.invalidate();
  group.property?.invalidate();
  group.dataview?.invalidate();
}

export function revalidateResolvers(group: ResolverGroup): void {
  group.wikilink?.markStale();
  group.embed?.markStale();
  group.property?.markStale();
  group.dataview?.invalidate();
}
