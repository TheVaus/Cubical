export function closestFromTarget(
  target: EventTarget | null,
  selector: string,
): Element | null {
  const el =
    target instanceof Element
      ? target
      : target instanceof Node
        ? target.parentElement
        : null;
  return el?.closest(selector) ?? null;
}
