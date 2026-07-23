export function isValidNoteName(name: string): boolean {
  const base = name.endsWith(".md") ? name.slice(0, -3) : name;
  return base.length > 0 && !base.includes(".");
}

export function noteNameError(name: string): string {
  return `"${name}" can't contain a dot — dots are reserved for property references like [[note.prop]].`;
}
