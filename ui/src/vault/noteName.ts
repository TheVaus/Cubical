export function stripMarkdownExtension(path: string): string {
  return path.endsWith(".md") ? path.slice(0, -3) : path;
}

export function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

export function noteTitle(path: string): string {
  return stripMarkdownExtension(basename(path));
}

export function parentPrefix(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash >= 0 ? path.slice(0, slash + 1) : "";
}

export function isValidNoteName(name: string): boolean {
  const base = stripMarkdownExtension(name);
  return base.length > 0 && !base.includes(".");
}

export function noteNameError(name: string): string {
  return `"${name}" can't contain a dot — dots are reserved for property references like [[note.prop]].`;
}
