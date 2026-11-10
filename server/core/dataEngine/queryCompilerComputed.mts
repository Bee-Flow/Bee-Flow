/**
 * Read-time computed fields: a computed field without `computed.stored: true`
 * has no column. A record read that asks for it (`readTimeComputed: true`)
 * gets it as an expression in the select list, `(<expr>) AS "key"`.
 *
 * The expression is author text that lands in a SELECT, which is a wider spot
 * than the `GENERATED ALWAYS AS (…)` a stored computed column lands in: the
 * DDL forbids subqueries and other tables, a select list does not. So this
 * guard is stricter than appStudio/dataModel/computedExprGuard.js and does not
 * pass the text on; it rebuilds the SQL from the tokens it checked:
 *   - a word is a keyword from a short list, a function from a list of
 *     functions that exist in BOTH SQLite and Postgres (followed by `(`), or a
 *     column of THIS table that holds a value (a system column, a stored field);
 *     anything else refuses the field. A column is emitted quoted, so no word an
 *     author types can become `SELECT`, `FROM` or a table name;
 *   - a string literal, a number, and the operators both engines share;
 *   - no comment, no `;`, no `.`, no `::`, no placeholder, balanced parentheses.
 *
 * A field the guard refuses reads NULL (`NULL AS "key"`), the read goes on.
 * The row is the row the access filter already let through, and every column
 * the expression may name is one `SELECT *` returns for that row anyway, so
 * the field shows nothing the viewer does not already read. `columns` lists
 * the names per field for a later column-rights check.
 *
 * The lexer reads characters, not regular expressions: the text is author
 * input.
 */

import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);

type Field = { key?: string; type?: string; computed?: { stored?: boolean; expr?: unknown } | null };
type TableMeta = { key?: string; fields?: Field[] };
type Token = { kind: 'string' | 'number' | 'word' | 'quoted' | 'op'; text: string };

const { SYSTEM_COLUMNS, DATA_LIMITS } = nodeRequire('./dataModel/vocabulary') as {
    SYSTEM_COLUMNS: readonly string[]; DATA_LIMITS: { MAX_COMPUTED_EXPR: number };
};
const { qi } = nodeRequire('./queryCompilerCore') as { qi(name: string): string };

/** Functions with the same name and meaning in SQLite (3.44+, math functions on) and Postgres. */
export const READ_TIME_FUNCTIONS: ReadonlySet<string> = new Set([
    'abs', 'round', 'sign', 'ceil', 'ceiling', 'floor', 'trunc', 'sqrt', 'power', 'mod', 'exp', 'ln', 'log10',
    'coalesce', 'nullif',
    'upper', 'lower', 'length', 'substr', 'substring', 'trim', 'ltrim', 'rtrim', 'replace', 'concat',
]);

/** Bare words both engines read the same way. Upper-cased for the compare. */
const KEYWORDS: ReadonlySet<string> = new Set([
    'CASE', 'WHEN', 'THEN', 'ELSE', 'END',
    'AND', 'OR', 'NOT', 'IS', 'NULL', 'IN', 'LIKE', 'BETWEEN', 'ESCAPE', 'TRUE', 'FALSE',
    'CAST', 'AS', 'TEXT', 'INTEGER', 'INT', 'REAL', 'NUMERIC', 'DECIMAL', 'VARCHAR',
    'CURRENT_DATE', 'CURRENT_TIME', 'CURRENT_TIMESTAMP',
]);

/** Longest first, so `<=` wins over `<`. */
const OPERATORS = ['||', '<>', '!=', '<=', '>=', '+', '-', '*', '/', '%', '=', '<', '>', '(', ')', ','];

const MAX_DEPTH = 32;

const isDigit = (c: string): boolean => c >= '0' && c <= '9';
const isWordStart = (c: string): boolean => (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_';
const isWordChar = (c: string): boolean => isWordStart(c) || isDigit(c);
const isSpace = (c: string): boolean => c === ' ' || c === '\t' || c === '\n' || c === '\r';

type Lexed = { tokens: Token[] } | { error: string };
type Step = { token: Token; end: number } | { error: string };

function readString(expr: string, i: number): Step {
    let j = i + 1;
    for (;;) {
        const q = expr.indexOf("'", j);
        if (q === -1) return { error: 'unterminated string literal' };
        if (expr[q + 1] === "'") { j = q + 2; continue; }
        const text = expr.slice(i, q + 1);
        // A backslash escapes the quote on a Postgres that runs without
        // standard_conforming_strings; refused so the literal ends where it seems to.
        if (text.includes('\\')) return { error: 'a backslash is not allowed in a string literal' };
        return { token: { kind: 'string', text }, end: q + 1 };
    }
}

function readQuoted(expr: string, i: number): Step {
    const q = expr.indexOf('"', i + 1);
    if (q === -1) return { error: 'unterminated quoted name' };
    const name = expr.slice(i + 1, q);
    if (!name || !isWordStart(name[0]) || ![...name].every(isWordChar)) return { error: 'a quoted name must be a plain column name' };
    return { token: { kind: 'quoted', text: name }, end: q + 1 };
}

function readDigits(expr: string, i: number): number {
    let j = i;
    while (j < expr.length && isDigit(expr[j])) j += 1;
    return j;
}

function readNumber(expr: string, i: number): Step {
    let j = readDigits(expr, i);
    if (expr[j] === '.') j = readDigits(expr, j + 1);
    if (expr[j] === 'e' || expr[j] === 'E') {
        let k = j + 1;
        if (expr[k] === '+' || expr[k] === '-') k += 1;
        const end = readDigits(expr, k);
        if (end === k) return { error: `malformed number at position ${i}` };
        j = end;
    }
    if (j < expr.length && (isWordChar(expr[j]) || expr[j] === '.')) return { error: `malformed number at position ${i}` };
    return { token: { kind: 'number', text: expr.slice(i, j) }, end: j };
}

function readWord(expr: string, i: number): Step {
    let j = i + 1;
    while (j < expr.length && isWordChar(expr[j])) j += 1;
    return { token: { kind: 'word', text: expr.slice(i, j) }, end: j };
}

function readOne(expr: string, i: number): Step {
    const ch = expr[i];
    if (expr.startsWith('--', i) || expr.startsWith('/*', i)) return { error: 'a comment is not part of an expression' };
    if (ch === "'") return readString(expr, i);
    if (ch === '"') return readQuoted(expr, i);
    if (isDigit(ch) || (ch === '.' && isDigit(expr[i + 1] ?? ''))) return readNumber(expr, i);
    if (isWordStart(ch)) return readWord(expr, i);
    const op = OPERATORS.find((o) => expr.startsWith(o, i));
    if (op) return { token: { kind: 'op', text: op }, end: i + op.length };
    return { error: `unexpected character ${JSON.stringify(ch)} at position ${i}` };
}

/** The tokens of an expression, or why it is not one. */
export function lexReadTimeExpr(expr: string): Lexed {
    const tokens: Token[] = [];
    let i = 0;
    while (i < expr.length) {
        if (isSpace(expr[i])) { i += 1; continue; }
        const step = readOne(expr, i);
        if ('error' in step) return step;
        tokens.push(step.token);
        i = step.end;
    }
    return { tokens };
}

/** The columns a read-time expression may name: system columns and every field that has a column. */
function valueColumns(tableMeta: TableMeta): Set<string> {
    const out = new Set<string>(SYSTEM_COLUMNS);
    for (const f of Array.isArray(tableMeta.fields) ? tableMeta.fields : []) {
        if (!f || typeof f.key !== 'string') continue;
        if (f.type === 'computed' && !(f.computed && f.computed.stored === true)) continue;
        out.add(f.key);
    }
    return out;
}

type Checked = { error: string } | { sql: string } | { column: string };

function checkWord(t: Token, next: Token | undefined, columns: Set<string>): Checked {
    const calls = !!next && next.kind === 'op' && next.text === '(';
    if (t.kind === 'quoted') {
        if (calls) return { error: `"${t.text}" cannot be called as a function` };
        return columns.has(t.text) ? { column: t.text } : { error: `"${t.text}" is not a column of this table` };
    }
    const upper = t.text.toUpperCase();
    const lower = t.text.toLowerCase();
    if (calls) {
        if (READ_TIME_FUNCTIONS.has(lower)) return { sql: lower };
        if (KEYWORDS.has(upper)) return { sql: upper };
        return { error: `function ${t.text}() is not available on both database engines` };
    }
    if (KEYWORDS.has(upper)) return { sql: upper };
    if (columns.has(lower)) return { column: lower };
    return { error: `"${t.text}" is not a column of this table` };
}

const PG_TRIM_IDIOM = ['rtrim', '(', 'rtrim', '(', 'cast', '(', '#col', 'as', 'text', ')', ',', "'0'", ')', ',', "'.'", ')'];

/**
 * SQLite renders the number 20.0 as '20.0', so authors trim it with
 * rtrim(rtrim(CAST(x AS TEXT),'0'),'.'). On Postgres that turns '20' into '2'.
 * computedDialect.js rewrites the same idiom for stored columns; here it is
 * matched on the checked tokens. Returns the column when tokens[k..] is the idiom.
 */
function trimIdiomAt(tokens: Token[], k: number): string | null {
    if (k + PG_TRIM_IDIOM.length > tokens.length) return null;
    let column: string | null = null;
    for (let n = 0; n < PG_TRIM_IDIOM.length; n += 1) {
        const want = PG_TRIM_IDIOM[n];
        const t = tokens[k + n];
        if (want === '#col') {
            if (t.kind !== 'word' && t.kind !== 'quoted') return null;
            column = t.text;
        } else if (t.kind === 'string' ? t.text !== want : t.text.toLowerCase() !== want) {
            return null;
        }
    }
    return column;
}

type Compiled = { sql: string; columns: string[] } | { error: string };

function emit(tokens: Token[], columns: Set<string>, dialect: string): Compiled {
    const parts: string[] = [];
    const used = new Set<string>();
    let depth = 0;
    for (let k = 0; k < tokens.length; k += 1) {
        const t = tokens[k];
        if (t.kind === 'string' || t.kind === 'number') { parts.push(t.text); continue; }
        if (t.kind === 'op') {
            depth += t.text === '(' ? 1 : t.text === ')' ? -1 : 0;
            if (depth < 0 || depth > MAX_DEPTH) return { error: 'unbalanced parentheses' };
            parts.push(t.text);
            continue;
        }
        const idiomCol = dialect === 'pg' ? trimIdiomAt(tokens, k) : null;
        const checked = checkWord(idiomCol === null ? t : tokens[k + 6], idiomCol === null ? tokens[k + 1] : undefined, columns);
        if ('error' in checked) return checked;
        if ('column' in checked) used.add(checked.column);
        if (idiomCol !== null && 'column' in checked) {
            parts.push(`trim_scale(${qi(checked.column)})::text`);
            k += PG_TRIM_IDIOM.length - 1;
            continue;
        }
        parts.push('column' in checked ? qi(checked.column) : checked.sql);
    }
    if (depth !== 0) return { error: 'unbalanced parentheses' };
    return { sql: parts.join(' '), columns: [...used] };
}

/**
 * The SQL of one read-time computed expression for `dialect`, rebuilt from its
 * checked tokens, with the columns it names; or why it reads empty.
 */
export function readTimeExprSql(expr: unknown, tableMeta: TableMeta, dialect: string): Compiled {
    if (typeof expr !== 'string' || !expr.trim()) return { error: 'the expression is empty' };
    if (expr.length > DATA_LIMITS.MAX_COMPUTED_EXPR) return { error: `the expression is longer than ${DATA_LIMITS.MAX_COMPUTED_EXPR} characters` };
    const lexed = lexReadTimeExpr(expr);
    if ('error' in lexed) return lexed;
    if (!lexed.tokens.length) return { error: 'the expression is empty' };
    return emit(lexed.tokens, valueColumns(tableMeta), dialect);
}

/** Why a read-time computed field reads empty in either dialect, or null when it is evaluated. */
export function readTimeComputedError(field: Field, tableMeta: TableMeta): string | null {
    for (const dialect of ['sqlite', 'pg']) {
        const out = readTimeExprSql(field && field.computed ? field.computed.expr : undefined, tableMeta, dialect);
        if ('error' in out) return out.error;
    }
    return null;
}

/** The read-time computed fields of a table, in field order. */
function readTimeComputedFields(tableMeta: TableMeta): Field[] {
    const fields = Array.isArray(tableMeta.fields) ? tableMeta.fields : [];
    return fields.filter((f) => f && f.type === 'computed' && !(f.computed && f.computed.stored === true)
        && typeof f.key === 'string' && f.key !== '' && !SYSTEM_COLUMNS.includes(f.key));
}

/** What a record read adds to its select list for the read-time computed fields. */
export type ComputedSelect = {
    /** `*, (<expr>) AS "a", NULL AS "b"` */
    list: string;
    /** `*, NULL AS "a", NULL AS "b"`: the same read with every computed field empty. */
    fallbackList: string;
    keys: string[];
    /** The keys the guard refused; they read NULL in `list` too. */
    refused: string[];
    /** Per evaluated key, the columns its expression names. */
    columns: Record<string, string[]>;
};

/** The select-list additions for `tableMeta`, or null when it has no read-time computed field. */
export function readTimeComputedSelect(tableMeta: TableMeta, dialect: string): ComputedSelect | null {
    const fields = readTimeComputedFields(tableMeta);
    if (!fields.length) return null;
    const exprs: string[] = [];
    const nulls: string[] = [];
    const keys: string[] = [];
    const refused: string[] = [];
    const columns: Record<string, string[]> = {};
    for (const f of fields) {
        const key = f.key as string;
        const out = readTimeExprSql(f.computed ? f.computed.expr : undefined, tableMeta, dialect);
        keys.push(key);
        nulls.push(`NULL AS ${qi(key)}`);
        if ('error' in out) {
            refused.push(key);
            exprs.push(`NULL AS ${qi(key)}`);
        } else {
            columns[key] = out.columns;
            exprs.push(`(${out.sql}) AS ${qi(key)}`);
        }
    }
    return { list: ['*', ...exprs].join(', '), fallbackList: ['*', ...nulls].join(', '), keys, refused, columns };
}
