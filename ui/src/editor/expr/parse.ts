import { tokenize, type BinaryOp, type Token } from "./tokenize";

export type Expr =
  | { kind: "number"; value: number }
  | { kind: "ref"; note: string | null; property: string }
  | { kind: "negate"; operand: Expr }
  | { kind: "binary"; op: BinaryOp; left: Expr; right: Expr };

export type ParseResult =
  | { ok: true; expr: Expr }
  | { ok: false; reason: "syntax" | "too_complex" };

const PRECEDENCE: Record<BinaryOp, number> = {
  "+": 1,
  "-": 1,
  "*": 2,
  "/": 2,
  "%": 2,
};

class Parser {
  private pos = 0;

  constructor(private readonly tokens: readonly Token[]) {}

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private advance(): Token | undefined {
    return this.tokens[this.pos++];
  }

  parseExpression(minPrecedence: number): Expr | null {
    let left = this.parseUnary();
    if (!left) return null;
    for (;;) {
      const next = this.peek();
      if (!next || next.kind !== "op") break;
      const precedence = PRECEDENCE[next.op];
      if (precedence < minPrecedence) break;
      this.advance();
      const right = this.parseExpression(precedence + 1);
      if (!right) return null;
      left = { kind: "binary", op: next.op, left, right };
    }
    return left;
  }

  private parseUnary(): Expr | null {
    const next = this.peek();
    if (next && next.kind === "op" && next.op === "-") {
      this.advance();
      const operand = this.parseUnary();
      return operand ? { kind: "negate", operand } : null;
    }
    return this.parsePrimary();
  }

  private parsePrimary(): Expr | null {
    const token = this.advance();
    if (!token) return null;
    if (token.kind === "number") return { kind: "number", value: token.value };
    if (token.kind === "ref") {
      return { kind: "ref", note: token.note, property: token.property };
    }
    if (token.kind === "lparen") {
      const inner = this.parseExpression(1);
      if (!inner) return null;
      const close = this.advance();
      if (!close || close.kind !== "rparen") return null;
      return inner;
    }
    return null;
  }

  atEnd(): boolean {
    return this.pos === this.tokens.length;
  }
}

export function parse(source: string): ParseResult {
  const tokens = tokenize(source);
  if (!tokens.ok) return { ok: false, reason: tokens.reason };
  const parser = new Parser(tokens.tokens);
  const expr = parser.parseExpression(1);
  if (!expr || !parser.atEnd()) return { ok: false, reason: "syntax" };
  return { ok: true, expr };
}
