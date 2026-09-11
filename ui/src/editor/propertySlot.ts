import { Facet, StateEffect } from "@codemirror/state";

export interface PropertyLookup {
  kind: "resolved" | "note_unresolved" | "property_missing";
  value: unknown;
}

export interface PropertyResolver {
  get(note: string, property: string): PropertyLookup | undefined;
  fetch(note: string, property: string): void;
  resolve(note: string, property: string): Promise<PropertyLookup>;
  invalidate(): void;
  markStale(): void;
  onUpdate(handler: () => void): () => void;
  version(): number;
}

export const propertyResolverFacet = Facet.define<
  PropertyResolver | null,
  PropertyResolver | null
>({
  combine: (values) => values[0] ?? null,
});

export const propertyResolverUpdated = StateEffect.define<null>();
