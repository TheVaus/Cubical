export type OfKind<S extends { kind: string }, K extends S["kind"]> = Extract<
  S,
  { kind: K }
>;

export const whenKind =
  <S extends { kind: string }, K extends S["kind"]>(state: () => S, kind: K) =>
  (): OfKind<S, K> | false => {
    const s = state();
    return s.kind === kind ? (s as OfKind<S, K>) : false;
  };
