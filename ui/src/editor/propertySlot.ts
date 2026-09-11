import { Facet, StateEffect } from "@codemirror/state";

import type { GetPropertyResponse } from "../api/ipc";

export interface PropertyResolver {
  get(note: string, property: string): GetPropertyResponse | undefined;
  fetch(note: string, property: string): void;
  resolve(note: string, property: string): Promise<GetPropertyResponse>;
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
