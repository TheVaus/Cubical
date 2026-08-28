import { parse, type Expr } from "./parse";

export type RefResolution =
  | { kind: "number"; value: number }
  | { kind: "not_a_number" }
  | { kind: "unresolved_note" }
  | { kind: "missing_property" }
  | { kind: "loading" };

export type ResolveRef = (note: string | null, property: string) => RefResolution;

export type EvalErrorKind =
  | "syntax"
  | "too_complex"
  | "not_a_number"
  | "unresolved_note"
  | "missing_property"
  | "divide_by_zero";

export type EvalOutcome =
  | { status: "ok"; value: number }
  | { status: "loading" }
  | { status: "error"; kind: EvalErrorKind };

const LOADING = { status: "loading" } as const;

function fail(kind: EvalErrorKind): EvalOutcome {
  return { status: "error", kind };
}

function walk(expr: Expr, resolve: ResolveRef): EvalOutcome {
  if (expr.kind === "number") return { status: "ok", value: expr.value };
  if (expr.kind === "ref") {
    const hit = resolve(expr.note, expr.property);
    if (hit.kind === "number") return { status: "ok", value: hit.value };
    if (hit.kind === "loading") return LOADING;
    return fail(hit.kind);
  }
  if (expr.kind === "negate") {
    const operand = walk(expr.operand, resolve);
    return operand.status === "ok"
      ? { status: "ok", value: -operand.value }
      : operand;
  }
  const left = walk(expr.left, resolve);
  if (left.status !== "ok") return left;
  const right = walk(expr.right, resolve);
  if (right.status !== "ok") return right;
  if ((expr.op === "/" || expr.op === "%") && right.value === 0) {
    return fail("divide_by_zero");
  }
  switch (expr.op) {
    case "+":
      return { status: "ok", value: left.value + right.value };
    case "-":
      return { status: "ok", value: left.value - right.value };
    case "*":
      return { status: "ok", value: left.value * right.value };
    case "/":
      return { status: "ok", value: left.value / right.value };
    case "%":
      return { status: "ok", value: left.value % right.value };
  }
}

export function evaluate(source: string, resolve: ResolveRef): EvalOutcome {
  const parsed = parse(source);
  if (!parsed.ok) return fail(parsed.reason);
  return walk(parsed.expr, resolve);
}
