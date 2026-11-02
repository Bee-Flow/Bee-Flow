// @typecheck strict
/**
 * The one piece of author-written SQL in a data model is a stored computed
 * column's expression, and ddl.js places it inside
 * `GENERATED ALWAYS AS (<expr>) STORED`. Whatever reaches that spot must be
 * an expression and nothing more: no second statement, no clause that closes
 * the parenthesis early and continues the column definition, no reference
 * into another schema.
 *
 * A denylist of characters cannot promise that. This reads the text as the
 * tokens an expression is made of and refuses anything else:
 *   - string literals ('…' with '' as the escaped quote), numbers,
 *     identifiers (bare, or "quoted" for a column name), the operators and
 *     punctuation an expression uses;
 *   - parentheses that balance;
 *   - a word before `(` only when it is on the function list (a "quoted"
 *     name never), any other word
 *     only when it is an expression keyword or a column name (a bare
 *     identifier). A `.` outside a number or a string is refused, so
 *     `schema.table` and `table.column` never pass.
 *
 * The lists are generous for what an app author writes (arithmetic, text,
 * CASE, COALESCE, date/time helpers); the point is the shape, not the
 * vocabulary.
 */

'use strict';

/** Words that may appear bare in an expression. Upper-cased for the compare. */
const KEYWORDS = new Set([
    'CASE', 'WHEN', 'THEN', 'ELSE', 'END',
    'AND', 'OR', 'NOT', 'IS', 'NULL', 'IN', 'LIKE', 'GLOB', 'BETWEEN', 'ESCAPE',
    'CAST', 'AS', 'TRUE', 'FALSE', 'COLLATE', 'NOCASE', 'BINARY',
    // Type names after CAST(x AS …)
    'TEXT', 'INTEGER', 'INT', 'REAL', 'NUMERIC', 'DECIMAL', 'BLOB', 'BOOLEAN', 'CHAR', 'VARCHAR', 'DATE', 'TIMESTAMP',
    'CURRENT_DATE', 'CURRENT_TIME', 'CURRENT_TIMESTAMP',
]);

/** Function names (lower-cased) an expression may call. */
const FUNCTIONS = new Set([
    'abs', 'round', 'floor', 'ceil', 'ceiling', 'sign', 'sqrt', 'power', 'mod', 'exp', 'ln', 'log', 'log10', 'trunc',
    'min', 'max', 'coalesce', 'nullif', 'ifnull', 'iif',
    'upper', 'lower', 'length', 'char_length', 'substr', 'substring', 'trim', 'ltrim', 'rtrim', 'replace', 'instr',
    'printf', 'format', 'char', 'chr', 'hex', 'quote', 'typeof', 'concat', 'left', 'right', 'lpad', 'rpad', 'reverse',
    'date', 'time', 'datetime', 'strftime', 'julianday', 'unixepoch', 'to_char', 'extract', 'date_trunc', 'now',
    'cast', 'trim_scale', 'greatest', 'least',
]);

/** Operators and punctuation, longest first so `<=` wins over `<`. */
const OPERATORS = ['||', '<>', '!=', '<=', '>=', '::', '+', '-', '*', '/', '%', '=', '<', '>', '(', ')', ','];

/**
 * @typedef {{ kind: 'string' | 'number' | 'word' | 'quoted' | 'op', text: string }} Token
 */

/**
 * Split an expression into tokens. Returns the tokens, or a message for the
 * first thing that is not part of an expression.
 * @param {string} expr
 * @returns {{ tokens: Token[] } | { error: string }}
 */
function tokenize(expr) {
    /** @type {Token[]} */
    const tokens = [];
    let i = 0;
    while (i < expr.length) {
        const ch = expr[i];
        if (/\s/.test(ch)) { i += 1; continue; }
        // A comment is never part of an expression; it is how text after the
        // expression is hidden from a reader.
        if (expr.startsWith('--', i) || expr.startsWith('/*', i)) return { error: `comment sequence at position ${i}` };
        if (ch === "'") {
            let j = i + 1;
            for (;;) {
                const q = expr.indexOf("'", j);
                if (q === -1) return { error: 'unterminated string literal' };
                if (expr[q + 1] === "'") { j = q + 2; continue; }
                tokens.push({ kind: 'string', text: expr.slice(i, q + 1) });
                i = q + 1;
                break;
            }
            continue;
        }
        if (ch === '"') {
            const q = expr.indexOf('"', i + 1);
            if (q === -1) return { error: 'unterminated quoted identifier' };
            const name = expr.slice(i + 1, q);
            if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return { error: `quoted identifier "${name.slice(0, 40)}" is not a plain column name` };
            tokens.push({ kind: 'quoted', text: name });
            i = q + 1;
            continue;
        }
        const num = /^(\d+(\.\d+)?|\.\d+)([eE][+-]?\d+)?/.exec(expr.slice(i));
        if (num) { tokens.push({ kind: 'number', text: num[0] }); i += num[0].length; continue; }
        const word = /^[A-Za-z_][A-Za-z0-9_]*/.exec(expr.slice(i));
        if (word) { tokens.push({ kind: 'word', text: word[0] }); i += word[0].length; continue; }
        const op = OPERATORS.find((o) => expr.startsWith(o, i));
        if (op) { tokens.push({ kind: 'op', text: op }); i += op.length; continue; }
        return { error: `unexpected character ${JSON.stringify(ch)} at position ${i}` };
    }
    return { tokens };
}

/**
 * Why a token followed by `next` is not an allowed call, or null. A quoted
 * name is a column; followed by `(` it would name a function the list never
 * sees. A bare word before `(` must be on the function or keyword list.
 * @param {Token} t
 * @param {Token | undefined} next
 * @returns {string | null}
 */
function callShapeError(t, next) {
    if (!next || next.kind !== 'op' || next.text !== '(') return null;
    if (t.kind === 'quoted') return `a quoted name ("${t.text}") cannot be called as a function`;
    if (t.kind === 'word' && !FUNCTIONS.has(t.text.toLowerCase()) && !KEYWORDS.has(t.text.toUpperCase())) {
        return `function ${t.text}() is not allowed in a computed expression`;
    }
    return null;
}

/**
 * Why `expr` is not an expression, or null when it is one.
 * @param {string} expr
 * @returns {string | null}
 */
function computedExprShapeError(expr) {
    const lexed = tokenize(expr);
    if ('error' in lexed) return lexed.error;
    const { tokens } = lexed;
    if (tokens.length === 0) return 'empty expression';
    let depth = 0;
    for (let k = 0; k < tokens.length; k += 1) {
        const t = tokens[k];
        if (t.kind === 'op') {
            if (t.text === '(') depth += 1;
            if (t.text === ')') {
                depth -= 1;
                if (depth < 0) return 'unbalanced parentheses';
            }
            continue;
        }
        const callError = callShapeError(t, tokens[k + 1]);
        if (callError) return callError;
        // A bare word that is neither a keyword nor a function is a column
        // name; nothing more to check for it.
    }
    if (depth !== 0) return 'unbalanced parentheses';
    return null;
}

module.exports = { computedExprShapeError, tokenize, KEYWORDS, FUNCTIONS };
