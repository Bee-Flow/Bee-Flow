/**
 * Small, safe spreadsheet formula evaluator (A1-style cells) - SHARED between
 * the server and the browser (the agent-hub copy is GENERATED, see
 * `npm run gen:shared`). Zero dependencies, self-contained on purpose: it must
 * load in Node 22 and in the browser without dragging engine.mjs along.
 *
 * Same house rules as engine.mjs: no eval / new Function, a hand-written
 * recursive-descent parser, and a CLOSED function whitelist (a Map, so a name
 * like `constructor(` can never reach the prototype chain). Cell contents come
 * from end users, so every input is bounded (see the LIMITS below).
 *
 * Raw cell input is a string. `=...` is a formula; otherwise '' is empty, a
 * numeric literal is a number, TRUE/FALSE (any case) is a boolean, anything
 * else is text.
 *
 * Grammar (function names and TRUE/FALSE are case-insensitive):
 *   comparison     := concat (('='|'<>'|'<'|'>'|'<='|'>=') concat)*
 *   concat         := additive ('&' additive)*
 *   additive       := multiplicative (('+'|'-') multiplicative)*
 *   multiplicative := power (('*'|'/') power)*
 *   power          := unary ('^' unary)*        left-assoc, like Excel
 *   unary          := ('-'|'+') unary | postfix  so =-2^2 is 4, like Excel
 *   postfix        := primary '%'*               percent divides by 100
 *   primary        := number | "string" | TRUE | FALSE | cell | range
 *                   | FUNC '(' (comparison (',' comparison)*)? ')'
 *                   | '(' comparison ')'
 * A range is only meaningful as a function argument; anywhere else it is #VALUE!.
 *
 * Errors are values, not exceptions: a cell result is `{ value, error, display }`
 * and a formula that reads an error cell yields that same error (except in an
 * IF branch that is not taken - IF is lazy).
 *
 * Evaluation order. Cell-to-cell dependencies are followed with an EXPLICIT
 * stack, never by JS recursion: a column of 20 000 cells that each read the
 * previous one must not overflow the call stack. A formula that reads a cell
 * that is not computed yet is abandoned ("Pending") and retried once that cell
 * is done. Dependencies are discovered dynamically (by what actually runs), so
 * `=IF(TRUE,1,A1)` in A1 is not a cycle. Only parse nesting and operator
 * chains recurse, and both are bounded by the formula length limit.
 *
 * @module sheet
 */

/** Longest formula body we parse (characters, without the leading '='). */
const MAX_FORMULA_LENGTH = 2000;
/** Most cells one range may cover; larger is #REF! (and never expanded). */
const MAX_RANGE_CELLS = 50000;
/** Deepest nesting of parentheses, function calls and unary operators. */
const MAX_DEPTH = 100;
/** Same limits as Excel: columns up to XFD, rows up to 1 048 576. */
const MAX_COLS = 16384;
const MAX_ROWS = 1048576;

/** Error codes a cell can show. #NUM! covers overflow / impossible math. */
export const SHEET_ERRORS = Object.freeze(['#VALUE!', '#DIV/0!', '#NAME?', '#REF!', '#ERROR!', '#CIRC!', '#NUM!']);

const E_VALUE = '#VALUE!';
const E_DIV0 = '#DIV/0!';
const E_NAME = '#NAME?';
const E_REF = '#REF!';
const E_ERROR = '#ERROR!';
const E_CIRC = '#CIRC!';
const E_NUM = '#NUM!';

/** A spreadsheet error travelling up the evaluator (plain class: no stack capture, they are routine). */
class SheetError {
    /** @param {string} code */
    constructor(code) { this.code = code; }
}

/** "This formula reads cells that are not computed yet." */
class Pending {
    /** @param {string[]} names */
    constructor(names) { this.names = names; }
}

const fail = (code) => new SheetError(code);

// ---------------------------------------------------------------------------
// Addresses
// ---------------------------------------------------------------------------

/**
 * 0-based column index -> letters (0 -> 'A', 25 -> 'Z', 26 -> 'AA').
 * @param {number} index
 * @returns {string}
 */
export function columnName(index) {
    let n = Math.floor(index) + 1;
    let out = '';
    while (n > 0) {
        const rem = (n - 1) % 26;
        out = String.fromCharCode(65 + rem) + out;
        n = Math.floor((n - 1) / 26);
    }
    return out;
}

/**
 * Column letters -> 0-based index ('A' -> 0, 'AA' -> 26). -1 when not letters.
 * @param {string} name
 * @returns {number}
 */
export function columnIndex(name) {
    if (typeof name !== 'string' || !/^[A-Za-z]+$/.test(name)) return -1;
    let n = 0;
    for (const ch of name.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
    return n - 1;
}

/**
 * 0-based (col, row) -> 'A1'.
 * @param {number} col
 * @param {number} row
 * @returns {string}
 */
export function cellName(col, row) {
    return `${columnName(col)}${row + 1}`;
}

const REF_RE = /^\$?([A-Za-z]+)\$?(\d+)$/;

/**
 * Split an A1 token WITHOUT range-checking it (the formula parser wants to tell
 * "not a reference" from "a reference outside the sheet", the latter is #REF!).
 * @param {string} ref
 * @returns {{col:number,row:number,valid:boolean}|null} null when not shaped like a reference
 */
function splitRef(ref) {
    const m = REF_RE.exec(ref);
    if (!m) return null;
    // More than 3 letters / 7 digits cannot be inside the limits; do not do big-number math on them.
    if (m[1].length > 3 || m[2].length > 7) return { col: 0, row: 0, valid: false };
    const col = columnIndex(m[1]);
    const row = parseInt(m[2], 10) - 1;
    return { col, row, valid: col >= 0 && col < MAX_COLS && row >= 0 && row < MAX_ROWS };
}

/**
 * Parse an A1-style reference (`$` markers allowed and ignored, any case).
 * @param {string} ref
 * @returns {{col:number,row:number}|null} 0-based, or null when malformed / outside the sheet
 */
export function parseCellRef(ref) {
    if (typeof ref !== 'string') return null;
    const s = splitRef(ref);
    return s && s.valid ? { col: s.col, row: s.row } : null;
}

/**
 * Whether raw cell input is a formula (starts with '=').
 * @param {unknown} raw
 * @returns {boolean}
 */
export function isFormula(raw) {
    return typeof raw === 'string' && raw.charCodeAt(0) === 61;
}

// ---------------------------------------------------------------------------
// Values and coercion
// ---------------------------------------------------------------------------

const NUMERIC_RE = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;

/**
 * Number from text, or null when the text is not a (finite) numeric literal.
 * @param {string} s
 * @returns {number|null}
 */
function numericText(s) {
    const t = s.trim();
    if (!NUMERIC_RE.test(t)) return null;
    const n = Number(t);
    return Number.isFinite(n) ? n : null;
}

/**
 * Interpret raw non-formula input.
 * @param {string} raw
 * @returns {number|string|boolean|null}
 */
function classifyConstant(raw) {
    if (raw === '') return null;
    const n = numericText(raw);
    if (n !== null) return n;
    const up = raw.trim().toUpperCase();
    if (up === 'TRUE') return true;
    if (up === 'FALSE') return false;
    return raw;
}

/**
 * Render a value for display: numbers with up to 10 decimals (trailing zeros
 * trimmed, so 0.1+0.2 shows 0.3 while the stored value stays a plain double),
 * booleans as TRUE/FALSE, empty as ''. Pass the cell's error code as the second
 * argument to get the code back.
 * @param {number|string|boolean|null|undefined} value
 * @param {string|null} [error]
 * @returns {string}
 */
export function formatValue(value, error = null) {
    if (error) return error;
    if (value === null || value === undefined) return '';
    if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) return E_NUM;
        const abs = Math.abs(value);
        // toFixed would print float noise digits (and exponent form from 1e21) for huge numbers.
        let s = abs >= 1e15 ? String(value) : value.toFixed(10);
        if (s.includes('.') && !s.includes('e')) s = s.replace(/0+$/, '').replace(/\.$/, '');
        return s === '-0' ? '0' : s;
    }
    return String(value);
}

/** Drop binary floating noise (15 significant digits, what Excel compares with). */
const clean = (n) => Number(n.toPrecision(15));

function toNumber(v) {
    if (v === null) return 0;
    if (typeof v === 'number') return v;
    if (typeof v === 'boolean') return v ? 1 : 0;
    const n = numericText(v);
    if (n === null) throw fail(E_VALUE);
    return n;
}

function toText(v) {
    if (v === null) return '';
    return typeof v === 'string' ? v : formatValue(v);
}

function toBool(v) {
    if (typeof v === 'boolean') return v;
    if (v === null) return false;
    if (typeof v === 'number') return v !== 0;
    const up = v.trim().toUpperCase();
    if (up === 'TRUE') return true;
    if (up === 'FALSE') return false;
    throw fail(E_VALUE);
}

/** A number result must be finite; overflow and NaN are #NUM!. */
function finite(n) {
    if (!Number.isFinite(n)) throw fail(E_NUM);
    return n === 0 ? 0 : n; // never keep -0
}

/** Excel's type order for comparison: numbers < text < booleans. */
const rank = (v) => (typeof v === 'number' ? 0 : typeof v === 'string' ? 1 : 2);

function compareValues(a, b) {
    // An empty operand takes the type of the other one (=A1="" and =A1=0 are both TRUE for an empty A1).
    if (a === null && b === null) { a = 0; b = 0; }
    else if (a === null) a = typeof b === 'string' ? '' : typeof b === 'boolean' ? false : 0;
    else if (b === null) b = typeof a === 'string' ? '' : typeof a === 'boolean' ? false : 0;
    const ra = rank(a);
    const rb = rank(b);
    if (ra !== rb) return ra < rb ? -1 : 1;
    if (ra === 0) { a = clean(a); b = clean(b); }
    else if (ra === 1) { a = a.toLowerCase(); b = b.toLowerCase(); }
    return a < b ? -1 : a > b ? 1 : 0;
}

/** Round half away from zero without binary noise (2.675 -> 2.68, like Excel). */
function roundTo(x, digits) {
    const d = Math.max(-300, Math.min(300, Math.trunc(digits)));
    const shift = (n, by) => {
        const [mant, exp = '0'] = String(n).split('e');
        return Number(`${mant}e${Number(exp) + by}`);
    };
    const abs = Math.abs(x);
    const r = shift(Math.round(shift(abs, d)), -d);
    return finite(x < 0 ? -r : r);
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

const COMPARE_OPS = new Set(['=', '<>', '<', '>', '<=', '>=']);
const NUMBER_RE = /\d+\.?\d*(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?/y;

/**
 * Split a formula body into tokens. Anything unknown is a parse error.
 * @param {string} src
 * @returns {{t:'num'|'str'|'word'|'op', v:string|number, call?:boolean}[]}
 */
function tokenize(src) {
    const toks = [];
    let i = 0;
    while (i < src.length) {
        const ch = src[i];
        if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') { i++; continue; }
        if ((ch >= '0' && ch <= '9') || (ch === '.' && src[i + 1] >= '0' && src[i + 1] <= '9')) {
            NUMBER_RE.lastIndex = i;
            const m = NUMBER_RE.exec(src);
            if (!m) throw fail(E_ERROR);
            toks.push({ t: 'num', v: Number(m[0]) });
            i += m[0].length;
            continue;
        }
        if (ch === '"') {
            let out = '';
            i++;
            for (;;) {
                if (i >= src.length) throw fail(E_ERROR); // unterminated string
                if (src[i] === '"') {
                    if (src[i + 1] === '"') { out += '"'; i += 2; continue; }
                    i++;
                    break;
                }
                out += src[i++];
            }
            toks.push({ t: 'str', v: out });
            continue;
        }
        if (/[A-Za-z_$]/.test(ch)) {
            let j = i + 1;
            while (j < src.length && /[A-Za-z0-9_$.]/.test(src[j])) j++;
            // `LOG10(` is a function, `A1` a cell: only the following '(' tells them apart.
            toks.push({ t: 'word', v: src.slice(i, j), call: src[j] === '(' });
            i = j;
            continue;
        }
        const two = src.slice(i, i + 2);
        if (two === '<>' || two === '<=' || two === '>=') { toks.push({ t: 'op', v: two }); i += 2; continue; }
        if ('+-*/^&=<>(),:%'.includes(ch)) { toks.push({ t: 'op', v: ch }); i++; continue; }
        throw fail(E_ERROR);
    }
    return toks;
}

/**
 * Parse a formula body (without the leading '=') into an AST. Throws SheetError(#ERROR!).
 * @param {string} src
 * @returns {object}
 */
function parseFormula(src) {
    if (src.length > MAX_FORMULA_LENGTH) throw fail(E_ERROR);
    const toks = tokenize(src);
    let pos = 0;
    let depth = -1; // the top-level expression is level 0
    const isOp = (v) => pos < toks.length && toks[pos].t === 'op' && toks[pos].v === v;
    const enter = () => { if (++depth > MAX_DEPTH) throw fail(E_ERROR); };

    function parseComparison() {
        enter();
        let left = parseConcat();
        while (pos < toks.length && toks[pos].t === 'op' && COMPARE_OPS.has(toks[pos].v)) {
            const op = toks[pos++].v;
            left = { type: 'bin', op, l: left, r: parseConcat() };
        }
        depth--;
        return left;
    }
    function parseConcat() {
        let left = parseAdditive();
        while (isOp('&')) { pos++; left = { type: 'bin', op: '&', l: left, r: parseAdditive() }; }
        return left;
    }
    function parseAdditive() {
        let left = parseMultiplicative();
        while (isOp('+') || isOp('-')) {
            const op = toks[pos++].v;
            left = { type: 'bin', op, l: left, r: parseMultiplicative() };
        }
        return left;
    }
    function parseMultiplicative() {
        let left = parsePower();
        while (isOp('*') || isOp('/')) {
            const op = toks[pos++].v;
            left = { type: 'bin', op, l: left, r: parsePower() };
        }
        return left;
    }
    function parsePower() {
        let left = parseUnary();
        while (isOp('^')) { pos++; left = { type: 'bin', op: '^', l: left, r: parseUnary() }; }
        return left;
    }
    function parseUnary() {
        if (isOp('-') || isOp('+')) {
            const op = toks[pos++].v;
            enter();
            const x = parseUnary();
            depth--;
            return { type: 'un', op, x };
        }
        let node = parsePrimary();
        while (isOp('%')) { pos++; node = { type: 'pct', x: node }; }
        return node;
    }
    function refNode(word) {
        const s = splitRef(word);
        return s ? { type: 'ref', col: s.col, row: s.row, bad: !s.valid } : null;
    }
    function parsePrimary() {
        const tok = toks[pos++];
        if (!tok) throw fail(E_ERROR);
        if (tok.t === 'num') return { type: 'num', v: tok.v };
        if (tok.t === 'str') return { type: 'str', v: tok.v };
        if (tok.t === 'op') {
            if (tok.v !== '(') throw fail(E_ERROR);
            const inner = parseComparison();
            if (!isOp(')')) throw fail(E_ERROR);
            pos++;
            return inner;
        }
        // word
        if (tok.call) {
            if (!/^[A-Za-z_][A-Za-z0-9_.]*$/.test(tok.v)) throw fail(E_ERROR);
            pos++; // '('
            const args = [];
            if (isOp(')')) pos++;
            else {
                for (;;) {
                    args.push(parseComparison());
                    if (isOp(',')) { pos++; continue; }
                    if (isOp(')')) { pos++; break; }
                    throw fail(E_ERROR);
                }
            }
            return { type: 'call', name: tok.v.toUpperCase(), args };
        }
        const a = refNode(tok.v);
        if (a) {
            if (!isOp(':')) return a;
            pos++;
            const t2 = toks[pos++];
            const b = t2 && t2.t === 'word' && !t2.call ? refNode(t2.v) : null;
            if (!b) throw fail(E_ERROR);
            return { type: 'range', a, b };
        }
        const up = tok.v.toUpperCase();
        if (up === 'TRUE') return { type: 'bool', v: true };
        if (up === 'FALSE') return { type: 'bool', v: false };
        return { type: 'name', name: tok.v }; // evaluates to #NAME?
    }

    const ast = parseComparison();
    if (pos !== toks.length) throw fail(E_ERROR);
    return ast;
}

// ---------------------------------------------------------------------------
// Functions
// ---------------------------------------------------------------------------

/**
 * Function names, for autocomplete. The implementations live in `evalCall`.
 * @type {readonly string[]}
 */
export const SHEET_FUNCTIONS = Object.freeze([
    'SUM', 'AVERAGE', 'MIN', 'MAX', 'COUNT', 'COUNTA', 'IF', 'AND', 'OR', 'NOT',
    'ROUND', 'ABS', 'CONCAT', 'CONCATENATE', 'LEN', 'UPPER', 'LOWER', 'TRIM',
]);
const FUNCTION_SET = new Set(SHEET_FUNCTIONS);

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

/**
 * Normalise a raw input to a string, or null when the cell is empty / unusable.
 * @param {unknown} raw
 * @returns {string|null}
 */
function rawString(raw) {
    if (raw === null || raw === undefined) return null;
    const s = typeof raw === 'string' ? raw : (typeof raw === 'number' || typeof raw === 'boolean') ? String(raw) : null;
    return s === null || s === '' ? null : s;
}

/**
 * Evaluate the given targets (all cells when omitted) of a sheet.
 * @param {Record<string,unknown>} cells
 * @param {string[]|null} targets normalised names to resolve
 * @returns {{done: Map<string,{value:any,error:string|null}>, order: string[]}}
 */
function run(cells, targets) {
    /** @type {Map<string,string>} name -> raw */
    const raws = new Map();
    for (const [key, raw] of Object.entries(cells && typeof cells === 'object' ? cells : {})) {
        const ref = parseCellRef(key.trim());
        const s = rawString(raw);
        if (!ref || s === null) continue;
        raws.set(cellName(ref.col, ref.row), s);
    }
    const order = [...raws.keys()];

    /** @type {Map<string,{value:any,error:string|null}>} finished cells */
    const done = new Map();
    /** @type {Set<string>} formula cells still to compute */
    const formulas = new Set();
    /** @type {Map<number,string>} row*MAX_COLS+col -> name, for range scans */
    const byPos = new Map();
    /** @type {{name:string,col:number,row:number}[]} */
    const positions = [];
    for (const [name, raw] of raws) {
        const { col, row } = parseCellRef(name);
        byPos.set(row * MAX_COLS + col, name);
        positions.push({ name, col, row });
        if (isFormula(raw)) formulas.add(name);
        else done.set(name, { value: classifyConstant(raw), error: null });
    }
    positions.sort((p, q) => p.row - q.row || p.col - q.col);

    const asts = new Map();
    const inProgress = new Set();

    // --- reading cells (throws Pending / SheetError) ---------------------------
    function readCell(node) {
        if (node.bad) throw fail(E_REF);
        const name = cellName(node.col, node.row);
        const res = done.get(name);
        if (res) {
            if (res.error) throw fail(res.error);
            return res.value;
        }
        if (formulas.has(name)) throw new Pending([name]);
        return null;
    }
    /** Non-empty values of a rectangle, row-major. Scans the cheaper of rectangle / known cells. */
    function readRange(a, b) {
        if (a.bad || b.bad) throw fail(E_REF);
        const c1 = Math.min(a.col, b.col); const c2 = Math.max(a.col, b.col);
        const r1 = Math.min(a.row, b.row); const r2 = Math.max(a.row, b.row);
        const size = (c2 - c1 + 1) * (r2 - r1 + 1);
        if (size > MAX_RANGE_CELLS) throw fail(E_REF);
        const names = [];
        if (size <= positions.length) {
            for (let r = r1; r <= r2; r++) {
                for (let c = c1; c <= c2; c++) {
                    const n = byPos.get(r * MAX_COLS + c);
                    if (n !== undefined) names.push(n);
                }
            }
        } else {
            for (const p of positions) if (p.col >= c1 && p.col <= c2 && p.row >= r1 && p.row <= r2) names.push(p.name);
        }
        const missing = names.filter((n) => !done.has(n));
        if (missing.length) throw new Pending(missing);
        const out = [];
        for (const n of names) {
            const res = done.get(n);
            if (res.error) throw fail(res.error);
            if (res.value !== null) out.push(res.value);
        }
        return out;
    }

    // --- AST evaluation ---------------------------------------------------------
    /** A function argument that stands for several cells (range) or one cell reference. */
    const isRef = (n) => n.type === 'range' || n.type === 'ref';
    const refValues = (n) => {
        if (n.type === 'range') return readRange(n.a, n.b);
        const v = readCell(n);
        return v === null ? [] : [v];
    };

    function evalNode(n) {
        switch (n.type) {
            case 'num': case 'str': case 'bool': return n.v;
            case 'ref': return readCell(n);
            case 'range': throw fail(E_VALUE);
            case 'name': throw fail(E_NAME);
            case 'un': {
                const x = toNumber(evalNode(n.x));
                return finite(n.op === '-' ? -x : x);
            }
            case 'pct': return finite(toNumber(evalNode(n.x)) / 100);
            case 'bin': return evalBinary(n);
            case 'call': return evalCall(n);
            default: throw fail(E_ERROR);
        }
    }

    function evalBinary(n) {
        const a = evalNode(n.l);
        const b = evalNode(n.r);
        switch (n.op) {
            case '&': return toText(a) + toText(b);
            case '=': return compareValues(a, b) === 0;
            case '<>': return compareValues(a, b) !== 0;
            case '<': return compareValues(a, b) < 0;
            case '>': return compareValues(a, b) > 0;
            case '<=': return compareValues(a, b) <= 0;
            case '>=': return compareValues(a, b) >= 0;
            default: break;
        }
        const x = toNumber(a);
        const y = toNumber(b);
        switch (n.op) {
            case '+': return finite(x + y);
            case '-': return finite(x - y);
            case '*': return finite(x * y);
            case '/':
                if (y === 0) throw fail(E_DIV0);
                return finite(x / y);
            case '^':
                if (x === 0 && y < 0) throw fail(E_DIV0);
                if (x === 0 && y === 0) throw fail(E_NUM);
                return finite(x ** y);
            default: throw fail(E_ERROR);
        }
    }

    /** Numbers for SUM/AVERAGE/MIN/MAX: cells and ranges contribute numbers only, direct args are coerced. */
    function numbersOf(args) {
        const nums = [];
        for (const a of args) {
            if (isRef(a)) { for (const v of refValues(a)) if (typeof v === 'number') nums.push(v); }
            else nums.push(toNumber(evalNode(a)));
        }
        return nums;
    }
    /** Logical values for AND/OR: cells and ranges contribute booleans and numbers (text ignored). */
    function boolsOf(args) {
        const out = [];
        for (const a of args) {
            if (isRef(a)) { for (const v of refValues(a)) if (typeof v !== 'string') out.push(toBool(v)); }
            else out.push(toBool(evalNode(a)));
        }
        if (!out.length) throw fail(E_VALUE);
        return out;
    }
    function arity(args, min, max) {
        if (args.length < min || args.length > max) throw fail(E_ERROR);
    }
    const scalarText = (args) => { arity(args, 1, 1); return toText(evalNode(args[0])); };

    function evalCall(n) {
        const { name, args } = n;
        if (!FUNCTION_SET.has(name)) throw fail(E_NAME);
        switch (name) {
            case 'IF': {
                arity(args, 2, 3);
                // Lazy on purpose: the branch not taken is never evaluated, so its errors and cycles do not count.
                if (toBool(evalNode(args[0]))) return evalNode(args[1]);
                return args.length === 3 ? evalNode(args[2]) : false;
            }
            case 'SUM': return finite(numbersOf(args).reduce((s, v) => s + v, 0));
            case 'AVERAGE': {
                const nums = numbersOf(args);
                if (!nums.length) throw fail(E_DIV0);
                return finite(nums.reduce((s, v) => s + v, 0) / nums.length);
            }
            case 'MIN': { const nums = numbersOf(args); return nums.length ? Math.min(...nums) : 0; }
            case 'MAX': { const nums = numbersOf(args); return nums.length ? Math.max(...nums) : 0; }
            case 'COUNT': {
                let count = 0;
                for (const a of args) {
                    if (isRef(a)) { for (const v of refValues(a)) if (typeof v === 'number') count++; }
                    else {
                        const v = evalNode(a);
                        if (typeof v === 'number' || typeof v === 'boolean' || (typeof v === 'string' && numericText(v) !== null)) count++;
                    }
                }
                return count;
            }
            case 'COUNTA': {
                let count = 0;
                for (const a of args) {
                    if (isRef(a)) count += refValues(a).length;
                    else { evalNode(a); count++; }
                }
                return count;
            }
            case 'AND': return boolsOf(args).every(Boolean);
            case 'OR': return boolsOf(args).some(Boolean);
            case 'NOT': arity(args, 1, 1); return !toBool(evalNode(args[0]));
            case 'ROUND': {
                arity(args, 1, 2);
                const x = toNumber(evalNode(args[0]));
                return roundTo(x, args.length === 2 ? toNumber(evalNode(args[1])) : 0);
            }
            case 'ABS': arity(args, 1, 1); return Math.abs(toNumber(evalNode(args[0])));
            case 'CONCAT': case 'CONCATENATE': {
                let out = '';
                for (const a of args) {
                    if (isRef(a)) { for (const v of refValues(a)) out += toText(v); }
                    else out += toText(evalNode(a));
                }
                return out;
            }
            case 'LEN': return scalarText(args).length;
            case 'UPPER': return scalarText(args).toUpperCase();
            case 'LOWER': return scalarText(args).toLowerCase();
            case 'TRIM': return scalarText(args).replace(/^ +| +$/g, '').replace(/ {2,}/g, ' ');
            default: throw fail(E_NAME);
        }
    }

    /** One attempt at a formula cell: a finished result, or throws Pending. */
    function attempt(name) {
        let ast = asts.get(name);
        if (!ast) {
            ast = parseFormula(raws.get(name).slice(1));
            asts.set(name, ast);
        }
        const v = evalNode(ast);
        return v === null ? 0 : v; // =A1 of an empty A1 shows 0, like Excel
    }

    /** Iterative depth-first resolution: the JS stack never grows with the dependency chain. */
    function resolve(start) {
        if (done.has(start) || !raws.has(start)) return;
        const stack = [start];
        while (stack.length) {
            const name = stack[stack.length - 1];
            if (done.has(name)) { stack.pop(); continue; }
            inProgress.add(name);
            try {
                done.set(name, { value: attempt(name), error: null });
                inProgress.delete(name);
                stack.pop();
            } catch (e) {
                if (e instanceof Pending) {
                    const loop = e.names.find((m) => inProgress.has(m));
                    if (loop !== undefined) {
                        // `loop` is an ancestor of this cell on the stack: everything in between is the cycle.
                        for (const member of stack.slice(stack.lastIndexOf(loop))) {
                            if (inProgress.has(member)) {
                                done.set(member, { value: null, error: E_CIRC });
                                inProgress.delete(member);
                            }
                        }
                    } else {
                        for (const m of e.names) stack.push(m);
                    }
                } else if (e instanceof SheetError) {
                    done.set(name, { value: null, error: e.code });
                    inProgress.delete(name);
                    stack.pop();
                } else {
                    throw e;
                }
            }
        }
    }

    for (const name of targets || order) resolve(name);
    return { done, order };
}

/**
 * @typedef {{ value: number|string|boolean|null, error: string|null, display: string }} CellResult
 */

/**
 * Evaluate a whole sheet. Keys are normalised to upper-case A1 names; every
 * non-empty input cell is in the result. Never throws on bad input: problems
 * are error codes on the cell.
 * @param {Record<string,string>} cells raw input per cell, e.g. `{ A1: '2', B1: '=A1*3' }`
 * @returns {Record<string, CellResult>}
 */
export function evaluateSheet(cells) {
    const { done, order } = run(cells, null);
    /** @type {Record<string, CellResult>} */
    const out = {};
    for (const name of order) {
        const r = done.get(name);
        out[name] = { value: r.value, error: r.error, display: formatValue(r.value, r.error) };
    }
    return out;
}

/**
 * Evaluate one cell (and only what it depends on). An empty / unknown cell gives an empty result.
 * @param {Record<string,string>} cells
 * @param {string} name e.g. 'B2' (any case, `$` allowed)
 * @returns {CellResult}
 */
export function evaluateCell(cells, name) {
    const ref = parseCellRef(typeof name === 'string' ? name.trim() : '');
    if (!ref) return { value: null, error: E_REF, display: E_REF };
    const key = cellName(ref.col, ref.row);
    const { done } = run(cells, [key]);
    const r = done.get(key);
    return r
        ? { value: r.value, error: r.error, display: formatValue(r.value, r.error) }
        : { value: null, error: null, display: '' };
}

/**
 * Names of the cells a formula reads (for highlighting). Ranges are expanded
 * unless they exceed the range limit. Not a formula / does not parse -> [].
 * @param {string} raw
 * @returns {string[]} upper-case A1 names, in order of first appearance, no duplicates
 */
export function referencedCells(raw) {
    if (!isFormula(raw)) return [];
    let ast;
    try { ast = parseFormula(raw.slice(1)); } catch { return []; }
    const seen = new Set();
    const add = (col, row) => seen.add(cellName(col, row));
    const walk = (n) => {
        switch (n.type) {
            case 'ref': if (!n.bad) add(n.col, n.row); break;
            case 'range': {
                if (n.a.bad || n.b.bad) break;
                const c1 = Math.min(n.a.col, n.b.col); const c2 = Math.max(n.a.col, n.b.col);
                const r1 = Math.min(n.a.row, n.b.row); const r2 = Math.max(n.a.row, n.b.row);
                if ((c2 - c1 + 1) * (r2 - r1 + 1) > MAX_RANGE_CELLS) break;
                for (let r = r1; r <= r2; r++) for (let c = c1; c <= c2; c++) add(c, r);
                break;
            }
            case 'un': case 'pct': walk(n.x); break;
            case 'bin': walk(n.l); walk(n.r); break;
            case 'call': n.args.forEach(walk); break;
            default: break;
        }
    };
    walk(ast);
    return [...seen];
}
