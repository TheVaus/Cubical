export const DEFAULT_DATE_FORMAT = "YYYY-MM-DD";

interface DateParts {
  y: number;
  m?: number;
  d?: number;
  h?: number;
  min?: number;
}

export type DateWidget = "date" | "datetime" | "number" | "text";

export interface DateFormatDef {
  token: string;
  placeholder: string;
  widget: DateWidget;
  hasTime: boolean;
  regex: RegExp;
  toParts(s: string): DateParts | null;
  fromParts(p: DateParts): string | null;
}

const pad = (n: number): string => String(n).padStart(2, "0");

function validParts(p: DateParts | null): p is DateParts {
  if (!p) return false;
  if (p.m !== undefined && (p.m < 1 || p.m > 12)) return false;
  if (p.d !== undefined && (p.d < 1 || p.d > 31)) return false;
  if (p.h !== undefined && (p.h < 0 || p.h > 23)) return false;
  if (p.min !== undefined && (p.min < 0 || p.min > 59)) return false;
  return true;
}

export const DATE_FORMATS: DateFormatDef[] = [
  {
    token: "YYYY-MM-DD",
    placeholder: "YYYY-MM-DD",
    widget: "date",
    hasTime: false,
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
    token: "YYYY-MM-DD HH:MM",
    placeholder: "YYYY-MM-DD HH:MM",
    widget: "datetime",
    hasTime: true,
    regex: /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/,
    toParts(s) {
      const m = this.regex.exec(s);
      return m
        ? { y: +m[1]!, m: +m[2]!, d: +m[3]!, h: +m[4]!, min: +m[5]! }
        : null;
    },
    fromParts(p) {
      return p.m && p.d && p.h !== undefined && p.min !== undefined
        ? `${p.y}-${pad(p.m)}-${pad(p.d)} ${pad(p.h)}:${pad(p.min)}`
        : null;
    },
  },
  {
    token: "YYYY",
    placeholder: "YYYY",
    widget: "number",
    hasTime: false,
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
    widget: "text",
    hasTime: false,
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
    widget: "text",
    hasTime: false,
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
    widget: "text",
    hasTime: false,
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
    widget: "text",
    hasTime: false,
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
    widget: "text",
    hasTime: false,
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

export function effectiveDateFormat(
  inline: string | undefined,
  vaultDefault: string | undefined,
): string {
  if (isKnownDateFormat(inline)) return inline!;
  if (isKnownDateFormat(vaultDefault)) return vaultDefault!;
  return DEFAULT_DATE_FORMAT;
}

export function validateDate(value: unknown, token: string): boolean {
  const fmt = getDateFormat(token);
  if (!fmt) return false;
  return validParts(fmt.toParts(String(value)));
}

export function convertDate(
  value: unknown,
  toToken: string,
): { value: string | number; lossy: boolean } {
  const target = getDateFormat(toToken);
  if (!target) return { value: "", lossy: true };
  const s = String(value ?? "").trim();
  let parts: DateParts | null = null;
  let sourceHadTime = false;
  for (const fmt of DATE_FORMATS) {
    const p = fmt.toParts(s);
    if (validParts(p)) {
      parts = p;
      sourceHadTime = fmt.hasTime;
      break;
    }
  }
  if (!parts) return { value: "", lossy: true };
  const rendered = target.fromParts(parts);
  if (rendered === null) return { value: "", lossy: true };
  const droppedTime = sourceHadTime && !target.hasTime;
  return {
    value: target.widget === "number" ? Number(rendered) : rendered,
    lossy: droppedTime,
  };
}
