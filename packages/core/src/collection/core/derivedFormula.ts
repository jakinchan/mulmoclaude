// Tiny expression evaluator for the `derived` field type on
// schema-driven collections (see plans/done/feat-mc-invoice.md).
//
// Grammar (recursive-descent, no precedence climbing — six
// non-terminals total):
//
//   expr   := term (('+' | '-') term)*
//   term   := factor (('*' | '/') factor)*
//   factor := number | sumCall | refAccess | identifier | '(' expr ')'
//   sumCall:= 'sum' '(' sumArg ')'
//   sumArg := tableCol (('*' | '/') tableCol)*      // e.g. lineItems[].quantity * lineItems[].rate
//   tableCol := identifier '[]' '.' identifier
//   refAccess := identifier '.' identifier          // e.g. ticker.price — deref a ref field into its target record
//
// `identifier` accepts top-level field names (single segment).
// Inside `sumArg`, identifiers are the `<table>[].col` form.
// A two-segment `<field>.<col>` at factor level is a *ref deref*:
// `<field>` must be a `ref`-typed field on this record (its stored
// value is the target item's slug), and `<col>` is a numeric column
// read from that target record. The caller resolves the target into
// `ctx.refs` (it owns the schema + the loaded target collection);
// the evaluator stays pure and never does I/O.
//
// What's deliberately NOT supported (and would parse-error rather
// than silently misbehave):
//   - String literals, boolean operators, comparisons, conditionals
//   - Nested function calls beyond `sum(...)`
//   - Anything in the record that isn't a number / table-of-objects
//
// All evaluation is pure — no eval(), no Function constructor.
// Returns `null` on any failure (parse error, unbound identifier,
// non-finite arithmetic). The caller renders `null` as em-dash in
// the table cell + form display.

import { isObj, isRecord, isUnknownArray } from "@mulmoclaude/common";

export interface FormulaContext {
  /** The record being evaluated. For derived fields in the form,
   *  this is the live draft (text + table both converted via the
   *  same `draftToRecord` pipeline). For the main table cell,
   *  this is the persisted item. */
  record: Record<string, unknown>;
  /** Resolved ref-target records for THIS row, keyed by the local
   *  `ref` field name. The caller (which has the schema + the linked
   *  collection's items loaded) maps each ref field's stored slug to
   *  the full target record and passes it here, so a `<field>.<col>`
   *  formula can read a numeric column off the referenced record
   *  (e.g. `shares * ticker.price`). A missing key or `null` value
   *  (unknown field / dangling slug) makes that deref evaluate to
   *  NaN → the whole formula returns `null` → em-dash, consistent
   *  with every other failure mode. Absent ⇒ no refs available. */
  refs?: Record<string, Record<string, unknown> | null>;
}

export function evaluateDerived(formula: string, ctx: FormulaContext): number | null {
  let tokens: Token[];
  try {
    tokens = tokenize(formula);
  } catch {
    return null;
  }
  // eslint-disable-next-line @typescript-eslint/no-use-before-define -- Parser class is defined later in the file (grouped with its AST + evaluator); evaluateDerived runs after module init so the TDZ concern doesn't apply.
  const parser = new Parser(tokens);
  let ast: Node;
  try {
    ast = parser.parseExpr();
    if (!parser.atEnd()) return null; // trailing junk
  } catch {
    return null;
  }
  const value = evaluate(ast, ctx);
  return Number.isFinite(value) ? value : null;
}

// ─── Tokens ────────────────────────────────────────────────

type PunctKind = "(" | ")" | "+" | "-" | "*" | "/" | "[]" | ".";
type TokenKind = "number" | "ident" | PunctKind;

// Discriminated so a `number` token's payload is a number and an
// `ident` token's payload is a string, with no reader having to assert it.
type Token = { kind: "number"; value: number } | { kind: "ident"; value: string } | { kind: PunctKind };

const SINGLE_CHAR_PUNCT: readonly PunctKind[] = ["(", ")", "+", "-", "*", "/", "."];

function isSingleCharPunct(char: string): char is PunctKind {
  return SINGLE_CHAR_PUNCT.some((punct) => punct === char);
}

interface Cursor {
  input: string;
  index: number;
}

function consumeWhitespace(cur: Cursor): boolean {
  const char = cur.input[cur.index];
  if (char === " " || char === "\t" || char === "\n") {
    cur.index++;
    return true;
  }
  return false;
}

function consumeNumber(cur: Cursor): Token | null {
  const char = cur.input[cur.index] ?? "";
  const next = cur.input[cur.index + 1] ?? "";
  if (!isDigit(char) && !(char === "." && isDigit(next))) return null;
  let raw = "";
  while (cur.index < cur.input.length) {
    const here = cur.input[cur.index] ?? "";
    if (!isDigit(here) && here !== ".") break;
    raw += here;
    cur.index++;
  }
  const num = Number(raw);
  if (!Number.isFinite(num)) throw new Error("bad number");
  return { kind: "number", value: num };
}

function consumeIdent(cur: Cursor): Token | null {
  const char = cur.input[cur.index] ?? "";
  if (!isIdentStart(char)) return null;
  let raw = "";
  while (cur.index < cur.input.length && isIdentChar(cur.input[cur.index] ?? "")) {
    raw += cur.input[cur.index];
    cur.index++;
  }
  return { kind: "ident", value: raw };
}

function consumePunct(cur: Cursor): Token | null {
  const char = cur.input[cur.index] ?? "";
  if (char === "[" && cur.input[cur.index + 1] === "]") {
    cur.index += 2;
    return { kind: "[]" };
  }
  if (isSingleCharPunct(char)) {
    cur.index++;
    return { kind: char };
  }
  return null;
}

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  const cur: Cursor = { input, index: 0 };
  while (cur.index < input.length) {
    if (consumeWhitespace(cur)) continue;
    // Number FIRST so a leading-dot literal (`.25`) isn't split by
    // the `.` punctuation branch.
    const numTok = consumeNumber(cur);
    if (numTok) {
      tokens.push(numTok);
      continue;
    }
    const punctTok = consumePunct(cur);
    if (punctTok) {
      tokens.push(punctTok);
      continue;
    }
    const identTok = consumeIdent(cur);
    if (identTok) {
      tokens.push(identTok);
      continue;
    }
    throw new Error(`unexpected char ${input[cur.index]}`);
  }
  return tokens;
}

function isDigit(char: string): boolean {
  return char >= "0" && char <= "9";
}
function isIdentStart(char: string): boolean {
  return (char >= "a" && char <= "z") || (char >= "A" && char <= "Z") || char === "_";
}
function isIdentChar(char: string): boolean {
  return isIdentStart(char) || isDigit(char);
}

// ─── AST + Parser ───────────────────────────────────────────

type AdditiveOperator = "+" | "-";
type MultiplicativeOperator = "*" | "/";
type BinaryOperator = AdditiveOperator | MultiplicativeOperator;

type Node =
  | { kind: "num"; value: number }
  | { kind: "ident"; name: string }
  | { kind: "ref"; field: string; col: string }
  | { kind: "binop"; operator: BinaryOperator; left: Node; right: Node }
  | { kind: "sum"; arg: SumArg };

function matchAdditive(kind: TokenKind | undefined): AdditiveOperator | null {
  return kind === "+" || kind === "-" ? kind : null;
}

function matchMultiplicative(kind: TokenKind | undefined): MultiplicativeOperator | null {
  return kind === "*" || kind === "/" ? kind : null;
}

interface TableCol {
  table: string;
  col: string;
}

interface SumArg {
  // factors multiplied/divided together; each is a (tableName, colName) ref into a row.
  factors: TableCol[];
  /** Operators between factors: length = factors.length - 1; each
   *  is "*" or "/". For a single-factor sum (`sum(lineItems[].amount)`)
   *  this is empty. */
  operators: MultiplicativeOperator[];
}

class Parser {
  private cursor = 0;
  constructor(private readonly tokens: Token[]) {}

  atEnd(): boolean {
    return this.cursor >= this.tokens.length;
  }
  private peek(): Token | undefined {
    return this.tokens[this.cursor];
  }
  private consume(): Token {
    const tok = this.tokens[this.cursor++];
    if (!tok) throw new Error("unexpected end of input");
    return tok;
  }
  private expectPunct(kind: PunctKind): void {
    const tok = this.consume();
    if (tok.kind !== kind) throw new Error(`expected ${kind}, got ${tok.kind}`);
  }
  private expectIdent(): string {
    const tok = this.consume();
    if (tok.kind !== "ident") throw new Error(`expected ident, got ${tok.kind}`);
    return tok.value;
  }
  private takeOperator<Op extends BinaryOperator>(match: (kind: TokenKind | undefined) => Op | null): Op | null {
    const operator = match(this.peek()?.kind);
    if (operator) this.consume();
    return operator;
  }
  /** Yields each operator of a chain, consuming it. Iteration keeps the caller's
   *  stack depth constant — a formula is user input, so its length must not
   *  decide whether we overflow. */
  private *operatorRun<Op extends BinaryOperator>(match: (kind: TokenKind | undefined) => Op | null): Generator<Op> {
    while (true) {
      const operator = this.takeOperator(match);
      if (!operator) return;
      yield operator;
    }
  }

  private parseChain<Op extends BinaryOperator>(match: (kind: TokenKind | undefined) => Op | null, parseOperand: () => Node): Node {
    const left = parseOperand();
    const rest: { operator: Op; right: Node }[] = [];
    for (const operator of this.operatorRun(match)) {
      rest.push({ operator, right: parseOperand() });
    }
    return rest.reduce<Node>((accumulated, { operator, right }) => ({ kind: "binop", operator, left: accumulated, right }), left);
  }

  parseExpr(): Node {
    return this.parseChain(matchAdditive, () => this.parseTerm());
  }

  private parseTerm(): Node {
    return this.parseChain(matchMultiplicative, () => this.parseFactor());
  }

  private parseFactor(): Node {
    const tok = this.peek();
    if (!tok) throw new Error("unexpected end in factor");
    if (tok.kind === "number") {
      this.consume();
      return { kind: "num", value: tok.value };
    }
    if (tok.kind === "(") {
      this.consume();
      const inner = this.parseExpr();
      this.expectPunct(")");
      return inner;
    }
    if (tok.kind === "ident") return this.parseIdentFactor(tok.value);
    throw new Error(`unexpected token ${tok.kind} in factor`);
  }

  private parseIdentFactor(name: string): Node {
    // sum(...) — only function call we support
    if (name === "sum" && this.tokens[this.cursor + 1]?.kind === "(") {
      this.consume(); // ident
      this.expectPunct("(");
      const arg = this.parseSumArg();
      this.expectPunct(")");
      return { kind: "sum", arg };
    }
    this.consume(); // ident
    // ref deref: `<field>.<col>` (e.g. ticker.price). The table-row
    // form `<table>[].col` only appears inside sum(), so a `.`
    // immediately after a top-level ident is unambiguously a ref
    // dereference here.
    if (this.peek()?.kind === ".") {
      this.consume(); // '.'
      return { kind: "ref", field: name, col: this.expectIdent() };
    }
    return { kind: "ident", name };
  }

  private parseSumArg(): SumArg {
    const factors = [this.parseTableCol()];
    const operators: MultiplicativeOperator[] = [];
    for (const operator of this.operatorRun(matchMultiplicative)) {
      operators.push(operator);
      factors.push(this.parseTableCol());
    }
    return { factors, operators };
  }

  private parseTableCol(): TableCol {
    const table = this.expectIdent();
    this.expectPunct("[]");
    this.expectPunct(".");
    return { table, col: this.expectIdent() };
  }
}

// ─── Evaluator ──────────────────────────────────────────────

type LeafNode = Exclude<Node, { kind: "binop" }>;

/** Post-order traversal step: either a subtree still to visit, or the operator
 *  whose two operands are already on the value stack. */
type EvalStep = { kind: "visit"; node: Node } | { kind: "apply"; operator: BinaryOperator };

/** Walks the tree with an explicit stack. `a + b + c + …` folds
 *  left-associatively, so the AST's left spine is as deep as the formula is
 *  long — recursing here would let a long (but valid) user-written formula
 *  blow the call stack, and the RangeError would escape `evaluateDerived`'s
 *  null contract into the caller. */
function evaluate(root: Node, ctx: FormulaContext): number {
  const steps: EvalStep[] = [{ kind: "visit", node: root }];
  const values: number[] = [];
  for (let step = steps.pop(); step; step = steps.pop()) {
    if (step.kind === "apply") {
      values.push(applyPending(step.operator, values));
    } else if (step.node.kind === "binop") {
      const { operator, left, right } = step.node;
      // Popped in reverse, so the left operand lands on `values` first.
      steps.push({ kind: "apply", operator }, { kind: "visit", node: right }, { kind: "visit", node: left });
    } else {
      values.push(evaluateLeaf(step.node, ctx));
    }
  }
  const result = values.pop();
  return result !== undefined && values.length === 0 ? result : Number.NaN;
}

function applyPending(operator: BinaryOperator, values: number[]): number {
  const right = values.pop();
  const left = values.pop();
  // Both operands are pushed before their apply step, so a gap means a
  // malformed traversal — fail soft to NaN like every other bad value.
  if (left === undefined || right === undefined) return Number.NaN;
  return applyBinop(operator, left, right);
}

function evaluateLeaf(node: LeafNode, ctx: FormulaContext): number {
  if (node.kind === "num") return node.value;
  if (node.kind === "ident") return toFiniteNumber(ctx.record[node.name]);
  if (node.kind === "ref") {
    // `<field>.<col>`: read `col` off the resolved target record the
    // caller put in ctx.refs. Unknown field / dangling slug → null →
    // NaN, so the whole formula fails soft to an em-dash.
    const target = ctx.refs?.[node.field] ?? null;
    if (!target) return Number.NaN;
    return toFiniteNumber(target[node.col]);
  }
  return evaluateSum(node.arg, ctx);
}

function applyBinop(operator: BinaryOperator, left: number, right: number): number {
  if (!Number.isFinite(left) || !Number.isFinite(right)) return Number.NaN;
  if (operator === "+") return left + right;
  if (operator === "-") return left - right;
  if (operator === "*") return left * right;
  // operator === "/"
  if (right === 0) return Number.NaN;
  return left / right;
}

function evaluateSum(arg: SumArg, ctx: FormulaContext): number {
  const first = arg.factors.at(0);
  if (!first) return 0;
  // All factors must reference the SAME table (you can't multiply
  // a row from lineItems against a row from another table — the
  // semantics would be ambiguous). Reject mismatch.
  if (arg.factors.some((factor) => factor.table !== first.table)) return Number.NaN;
  const rows = ctx.record[first.table];
  if (!isUnknownArray(rows)) return 0;
  // A NaN from any row poisons the total, which the caller turns into null.
  return rows.filter(isObj).reduce((total, row) => total + rowProduct(row, arg), 0);
}

function rowProduct(row: object, { factors, operators }: SumArg): number {
  const [first, ...rest] = factors;
  if (!first) return Number.NaN;
  return rest.reduce(
    (product, factor, index) => {
      // The parser pushes one operator per extra factor, so a gap here means a
      // malformed SumArg — fail soft to NaN like every other bad value.
      const operator = operators[index];
      return operator ? applyBinop(operator, product, columnNumber(row, factor.col)) : Number.NaN;
    },
    columnNumber(row, first.col),
  );
}

function columnNumber(row: object, col: string): number {
  // An array row has no named column, so it fails soft like any other bad value.
  return isRecord(row) ? toFiniteNumber(row[col]) : Number.NaN;
}

function toFiniteNumber(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : Number.NaN;
  if (typeof value === "string" && value.length > 0) {
    const num = Number(value);
    return Number.isFinite(num) ? num : Number.NaN;
  }
  return Number.NaN;
}
