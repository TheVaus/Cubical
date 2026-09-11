import type { DataviewRunner } from "../editor/dataview";
import type { EmbedResolver } from "../editor/embedResolver";
import type { PropertyResolver } from "../editor/propertyResolver";
import type { WikiLinkResolver } from "../editor/wikilinkResolver";

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
