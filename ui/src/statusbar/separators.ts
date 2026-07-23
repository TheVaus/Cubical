export function leadingSeparators(visible: boolean[]): boolean[] {
  let anyBefore = false;
  return visible.map((v) => {
    const sep = v && anyBefore;
    if (v) anyBefore = true;
    return sep;
  });
}
