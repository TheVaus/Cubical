export type TokenizedRun =
  | { kind: "text"; value: string }
  | { kind: "tag"; path: string };

export function scanTags(input: string): TokenizedRun[] {
  if (input.length === 0) return [];
  const out: TokenizedRun[] = [];
  let cursor = 0;
  let i = 0;
  while (i < input.length) {
    if (input.charCodeAt(i) !== 0x23 ) {
      i++;
      continue;
    }
    if (i > 0 && !isAsciiWs(input.charCodeAt(i - 1))) {
      i++;
      continue;
    }
    const end = parseBody(input, i + 1);
    if (end < 0) {
      i++;
      continue;
    }
    if (i > cursor) {
      out.push({ kind: "text", value: input.slice(cursor, i) });
    }
    out.push({ kind: "tag", path: input.slice(i + 1, end) });
    cursor = end;
    i = end;
  }
  if (cursor < input.length) {
    out.push({ kind: "text", value: input.slice(cursor) });
  }
  return out;
}

function parseBody(input: string, start: number): number {
  if (start >= input.length) return -1;
  if (!isBodyStart(input.charCodeAt(start))) return -1;
  let i = start + 1;
  while (i < input.length) {
    const c = input.charCodeAt(i);
    if (isBodyCont(c)) {
      i++;
    } else if (c === 0x2f ) {
      if (i + 1 < input.length && isBodyCont(input.charCodeAt(i + 1))) {
        i += 2;
        while (i < input.length && isBodyCont(input.charCodeAt(i))) i++;
      } else {
        break;
      }
    } else {
      break;
    }
  }
  return i;
}

function isAsciiWs(c: number): boolean {
  return c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d;
}

function isBodyStart(c: number): boolean {
  return (
    (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) || c === 0x5f
  );
}

function isBodyCont(c: number): boolean {
  return (
    (c >= 0x41 && c <= 0x5a) ||
    (c >= 0x61 && c <= 0x7a) ||
    (c >= 0x30 && c <= 0x39) ||
    c === 0x5f ||
    c === 0x2d
  );
}
