/**
 * Curated date-format table (spec §4b). No date library: each format has
 * an explicit validation regex and parse/format rules. Pure + node-test
 * friendly. The grammar (typeComments) stores the token verbatim, so
 * adding a format is a one-row change here.
 */

export const DEFAULT_DATE_FORMAT = "YYYY-MM-DD";

interface DateParts {
  y: number;
  m?: number;
  d?: number;
}

export interface DateFormatDef {
  token: string;
  /** Placeholder/hint shown in the text input. */
  placeholder: string;
  /** Use the native `<input type=date>` (only YYYY-MM-DD). */
  native: boolean;
  /** Value is a YAML number, not a string (only YYYY). */
  numeric: boolean;
  regex: RegExp;
  /** Parse a string into parts, or null if it does not match. */
  toParts(s: string): DateParts | null;
  /** Render parts, or null if a required part is missing. */
  fromParts(p: DateParts): string | null;
}

const pad = (n: number): string => String(n).padStart(2, "0");

/**
 * Parts are well-formed when the month (1–12) and day (1–31) are in
 * range. Used to skip formats that share a regex but produce impossible
 * values — e.g. `17/06/2026` can't be `MM/DD/YYYY` (month 17), so the
 * parser falls through to `DD/MM/YYYY`.
 */
function validParts(p: DateParts | null): p is DateParts {
  if (!p) return false;
  if (p.m !== undefined && (p.m < 1 || p.m > 12)) return false;
  if (p.d !== undefined && (p.d < 1 || p.d > 31)) return false;
  return true;
}

export const DATE_FORMATS: DateFormatDef[] = [
  {
    token: "YYYY-MM-DD",
    placeholder: "YYYY-MM-DD",
    native: true,
    numeric: false,
    regex: /^(\d{4})-(\d{2})-(\d{2})$/,
    toParts(s) {
      const m = this.regex.exec(s);
      return m ? { y: +m[1]!, m: +m[2]!, d: +m[3]! } : null;
    },
    fromParts(p) {
      return p.m && p.d ? `${p.y}-${pad(p.m)}-${pad(p.d)}` : null;
    },
  },
  {
    token: "YYYY",
    placeholder: "YYYY",
    native: false,
    numeric: true,
    regex: /^(\d{4})$/,
    toParts(s) {
      const m = this.regex.exec(s);
      return m ? { y: +m[1]! } : null;
    },
    fromParts(p) {
      return `${p.y}`;
    },
  },
  {
    token: "YYYY-MM",
    placeholder: "YYYY-MM",
    native: false,
    numeric: false,
    regex: /^(\d{4})-(\d{2})$/,
    toParts(s) {
      const m = this.regex.exec(s);
      return m ? { y: +m[1]!, m: +m[2]! } : null;
    },
    fromParts(p) {
      return p.m ? `${p.y}-${pad(p.m)}` : null;
    },
  },
  {
    token: "DD-MM-YYYY",
    placeholder: "DD-MM-YYYY",
    native: false,
    numeric: false,
    regex: /^(\d{2})-(\d{2})-(\d{4})$/,
    toParts(s) {
      const m = this.regex.exec(s);
      return m ? { d: +m[1]!, m: +m[2]!, y: +m[3]! } : null;
    },
    fromParts(p) {
      return p.m && p.d ? `${pad(p.d)}-${pad(p.m)}-${p.y}` : null;
    },
  },
  {
    token: "DD-MM-YY",
    placeholder: "DD-MM-YY",
    native: false,
    numeric: false,
    regex: /^(\d{2})-(\d{2})-(\d{2})$/,
    toParts(s) {
      const m = this.regex.exec(s);
      return m ? { d: +m[1]!, m: +m[2]!, y: 2000 + +m[3]! } : null;
    },
    fromParts(p) {
      return p.m && p.d ? `${pad(p.d)}-${pad(p.m)}-${pad(p.y % 100)}` : null;
    },
  },
  {
    token: "MM/DD/YYYY",
    placeholder: "MM/DD/YYYY",
    native: false,
    numeric: false,
    regex: /^(\d{2})\/(\d{2})\/(\d{4})$/,
    toParts(s) {
      const m = this.regex.exec(s);
      return m ? { m: +m[1]!, d: +m[2]!, y: +m[3]! } : null;
    },
    fromParts(p) {
      return p.m && p.d ? `${pad(p.m)}/${pad(p.d)}/${p.y}` : null;
    },
  },
  {
    token: "DD/MM/YYYY",
    placeholder: "DD/MM/YYYY",
    native: false,
    numeric: false,
    regex: /^(\d{2})\/(\d{2})\/(\d{4})$/,
    toParts(s) {
      const m = this.regex.exec(s);
      return m ? { d: +m[1]!, m: +m[2]!, y: +m[3]! } : null;
    },
    fromParts(p) {
      return p.m && p.d ? `${pad(p.d)}/${pad(p.m)}/${p.y}` : null;
    },
  },
];

export const DATE_FORMAT_TOKENS: string[] = DATE_FORMATS.map((f) => f.token);

export function getDateFormat(token: string): DateFormatDef | undefined {
  return DATE_FORMATS.find((f) => f.token === token);
}

export function isKnownDateFormat(token: string | undefined): boolean {
  return token !== undefined && getDateFormat(token) !== undefined;
}

/** inline format → vault default → ISO, ignoring unknown tokens. */
export function effectiveDateFormat(
  inline: string | undefined,
  vaultDefault: string | undefined,
): string {
  if (isKnownDateFormat(inline)) return inline!;
  if (isKnownDateFormat(vaultDefault)) return vaultDefault!;
  return DEFAULT_DATE_FORMAT;
}

/** Whether `value` is a valid instance of `token`'s format. */
export function validateDate(value: unknown, token: string): boolean {
  const fmt = getDateFormat(token);
  if (!fmt) return false;
  return validParts(fmt.toParts(String(value)));
}

/**
 * Convert `value` to the `toToken` format, best-effort. Parses against
 * every known format to recover parts, then renders. Returns a blank +
 * `lossy` when no format parses the input, or when the target needs a
 * month/day the source lacks (no parts are invented).
 */
export function convertDate(
  value: unknown,
  toToken: string,
): { value: string | number; lossy: boolean } {
  const target = getDateFormat(toToken);
  if (!target) return { value: "", lossy: true };
  const s = String(value ?? "").trim();
  let parts: DateParts | null = null;
  for (const fmt of DATE_FORMATS) {
    const p = fmt.toParts(s);
    if (validParts(p)) {
      parts = p;
      break;
    }
  }
  if (!parts) return { value: "", lossy: true };
  const rendered = target.fromParts(parts);
  if (rendered === null) return { value: "", lossy: true };
  return { value: target.numeric ? Number(rendered) : rendered, lossy: false };
}
