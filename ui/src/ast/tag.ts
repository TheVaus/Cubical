/**
 * Pure TS inline-tag tokenizer — behavioural mirror of
 * `crates/cubical-ast/src/tag.rs::scan_tags`.
 *
 * Scans an `Inline::Text` value for `#tag` / `#parent/child` runs and
 * yields a sequence of `TokenizedRun`s. Grammar is locked by the L1
 * parity harness fixtures; both languages must produce identical output
 * for every fixture string.
 */

/** One run produced by {@link scanTags}. */
export type TokenizedRun =
  | { kind: "text"; value: string }
  | { kind: "tag"; path: string };

/**
 * Scan a text run for `#tag` and `#nested/tag`. Returns an empty array
 * for an empty input; otherwise always at least one element.
 */
export function scanTags(input: string): TokenizedRun[] {
  if (input.length === 0) return [];
  const out: TokenizedRun[] = [];
  let cursor = 0;
  let i = 0;
  while (i < input.length) {
    if (input.charCodeAt(i) !== 0x23 /* # */) {
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

/**
 * Returns the exclusive end index of a valid tag body starting at
 * `start` (the byte after the `#`), or -1 if the body is empty / starts
 * with an invalid char / is a bare digit run.
 */
function parseBody(input: string, start: number): number {
  if (start >= input.length) return -1;
  if (!isBodyStart(input.charCodeAt(start))) return -1;
  let i = start + 1;
  while (i < input.length) {
    const c = input.charCodeAt(i);
    if (isBodyCont(c)) {
      i++;
    } else if (c === 0x2f /* / */) {
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

/** First byte of a tag body: ASCII letter or underscore (no digit start). */
function isBodyStart(c: number): boolean {
  return (
    (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) || c === 0x5f
  );
}

/** Continuation byte of a tag body: ASCII alphanumeric, `_`, `-`. */
function isBodyCont(c: number): boolean {
  return (
    (c >= 0x41 && c <= 0x5a) ||
    (c >= 0x61 && c <= 0x7a) ||
    (c >= 0x30 && c <= 0x39) ||
    c === 0x5f ||
    c === 0x2d
  );
}
