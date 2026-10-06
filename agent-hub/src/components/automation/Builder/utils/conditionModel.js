/**
 * Condition model for the clickable Filter / Condition / Switch builder: rows
 * `{ field, op, value, threshold?, quantifier?, keepBlank? }` joined by one `join` ('&&' | '||').
 * `field` is a binding (File type is the ref `fileType(item)` or `fileType(item.attachments[*])`),
 * `op` an OPERATORS key, `quantifier` 'any' | 'every' | 'none' for a column of a list inside the
 * item, `keepBlank` a saved `x == ""` that keeps round-tripping. Pure: rows serialise to the shared
 * engine's `expr` and parse back; anything else parses to null (a formula). Text helpers shared
 * with the phone live in shared/expr/rules.mjs.
 */
import { appendKey } from '@shared/expr/path.mjs';
import {
    fieldShape, findTopLevelSymbol, quantifiedCall, readQuantifiedCall, splitCallArgs, splitTopLevel,
    TEST_OF_OP, UNARY_TESTS,
} from '@shared/expr/rules.mjs';
import { renderBindingValue, isCleanPath, bindingFromInput, canonicalRefPath } from '../../../../utils/bindingHelpers';
import { ISO_DATE_RE } from '../mapping/fieldKinds';

/** A coarse datatype from a sample value: picks the operators offered. */
export function inferType(value) {
    if (value == null) return 'unknown';
    if (Array.isArray(value)) {
        const first = value.find((v) => v != null);
        return first && typeof first === 'object' && !Array.isArray(first) ? 'records' : 'array';
    }
    const t = typeof value;
    if (t === 'number') return 'number';
    if (t === 'boolean') return 'boolean';
    if (t === 'object') return 'object';
    if (t === 'string') {
        if (ISO_DATE_RE.test(value.trim())) return 'date';
        return 'string';
    }
    return 'unknown';
}

// kind: 'cmp' (binary symbol) | 'fn' (helper call) | 'unary' (no value input)
//       | 'topic' (isAbout, answered by the topic classifier). `label` is the
// English of `condition_node.op.<key>`.
const OPERATORS = [
    // Text "is": equals() ignores upper/lower case and surrounding spaces.
    { key: 'is',    kind: 'fn', fn: 'equals', label: 'is' },
    { key: 'isNot', kind: 'fn', fn: 'equals', label: 'is not', negate: true },
    { key: 'eq',  kind: 'cmp', symbol: '==',  label: 'equals' },
    { key: 'neq', kind: 'cmp', symbol: '!=',  label: 'does not equal' },
    { key: 'gt',  kind: 'cmp', symbol: '>',   label: 'greater than' },
    { key: 'gte', kind: 'cmp', symbol: '>=',  label: 'greater than or equal' },
    { key: 'lt',  kind: 'cmp', symbol: '<',   label: 'less than' },
    { key: 'lte', kind: 'cmp', symbol: '<=',  label: 'less than or equal' },
    // Strict equality: hidden from the menu, kept so a saved === round-trips.
    { key: 'seq',  kind: 'cmp', symbol: '===', label: 'strictly equals', hidden: true },
    { key: 'sneq', kind: 'cmp', symbol: '!==', label: 'strictly does not equal', hidden: true },
    // `negate` wraps the call in `!` (`!contains(l, r)`).
    { key: 'contains',    kind: 'fn', fn: 'contains',   label: 'contains' },
    { key: 'notContains', kind: 'fn', fn: 'contains',   label: 'does not contain', negate: true },
    { key: 'startsWith',  kind: 'fn', fn: 'startsWith', label: 'starts with' },
    { key: 'endsWith',    kind: 'fn', fn: 'endsWith',   label: 'ends with' },
    { key: 'isEmpty',    kind: 'unary', label: 'is empty',     emit: (l) => `isEmpty(${l})` },
    { key: 'isNotEmpty', kind: 'unary', label: 'is not empty', emit: (l) => `!isEmpty(${l})` },
    { key: 'isTrue',     kind: 'unary', label: 'is true',      emit: (l) => `${l} == true` },
    { key: 'isFalse',    kind: 'unary', label: 'is false',     emit: (l) => `${l} == false` },
    // "has a value": a bare field, emitted verbatim so it round-trips.
    { key: 'truthy', kind: 'unary', label: 'has a value', emit: (l) => l },
    // Routing by meaning: the value is a topic in words; `threshold` (0..1) optional.
    { key: 'isAbout',  kind: 'topic', label: 'is about' },
    { key: 'notAbout', kind: 'topic', label: 'is not about', negate: true },
];

const OP_BY_KEY = new Map(OPERATORS.map((o) => [o.key, o]));

export const getOperator = (key) => OP_BY_KEY.get(key) || null;
export const isUnaryOp = (key) => getOperator(key)?.kind === 'unary';
export const isTopicOp = (key) => getOperator(key)?.kind === 'topic';

const TOPIC_TYPES = new Set(['string', 'unknown']);

// Operators per datatype. Text offers "is" (equals, any case); a saved `==` keeps its own.
const TYPE_OPS = {
    string:   ['is', 'isNot', 'contains', 'notContains', 'startsWith', 'endsWith', 'isEmpty', 'isNotEmpty', 'truthy'],
    number:   ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'truthy'],
    boolean:  ['isTrue', 'isFalse', 'eq', 'neq', 'truthy'],
    date:     ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'truthy'],
    array:    ['contains', 'notContains', 'isEmpty', 'isNotEmpty', 'truthy'],
    object:   ['eq', 'neq', 'isEmpty', 'isNotEmpty', 'truthy'],
    records:  ['isNotEmpty', 'isEmpty'],
    fileType: ['is', 'isNot'],
    unknown:  ['is', 'isNot', 'contains', 'notContains', 'startsWith', 'endsWith', 'gt', 'lt', 'isEmpty', 'isNotEmpty', 'truthy'],
};

/** @typedef {(key: string, en: string, vars?: Record<string, unknown>) => string} Translate */

/**
 * Operator options for a datatype. `currentKey` is always kept so a parsed operator round-trips.
 * `topics` (`{ available }`) adds "is about" (disabled when unavailable); `quantified` keeps what a quantifier can test.
 * @param {string} type
 * @param {string|null} [currentKey]
 * @param {{ topics?: { available?: boolean }|null, quantified?: boolean, t?: Translate|null }} [opts]
 * @returns {Array<{ key: string, label: string, disabled?: boolean }>}
 */
export function operatorsForType(type, currentKey = null, { topics = null, quantified = false, t = null } = {}) {
    let list = (TYPE_OPS[type] || TYPE_OPS.unknown).slice();
    if (topics && TOPIC_TYPES.has(type)) list.push('isAbout', 'notAbout');
    if (quantified) list = list.filter((k) => k in TEST_OF_OP);
    if (currentKey && !list.includes(currentKey)) list.push(currentKey);
    return list
        .map((k) => OP_BY_KEY.get(k))
        .filter(Boolean)
        .map((o) => ({
            key: o.key,
            label: labelFor(o.key, type, t),
            ...(o.kind === 'topic' && !topics?.available && o.key !== currentKey ? { disabled: true } : {}),
        }));
}

// The English of the type-dependent label keys (`condition_node.op.<key>_<variant>`).
const VARIANT_EN = {
    eq_date: 'is on', gt_date: 'is after', gte_date: 'is on or after', lt_date: 'is before', lte_date: 'is on or before',
    eq_text: 'is exactly (same upper/lower case)', neq_text: 'is not exactly (same upper/lower case)',
    isEmpty_records: 'has none', isNotEmpty_records: 'has at least one',
};

function labelKey(key, type) {
    if (type === 'date' && ['eq', 'gt', 'gte', 'lt', 'lte'].includes(key)) return `${key}_date`;
    if ((type === 'string' || type === 'unknown') && (key === 'eq' || key === 'neq')) return `${key}_text`;
    if (type === 'records' && (key === 'isEmpty' || key === 'isNotEmpty')) return `${key}_records`;
    return key;
}

/**
 * The operator's words for a field of `type`; `t` translates (English without it).
 * @param {string} key
 * @param {string} type
 * @param {Translate|null} [t]
 * @returns {string}
 */
export function labelFor(key, type, t = null) {
    const o = OP_BY_KEY.get(key);
    if (!o) return key;
    const k = labelKey(key, type);
    const en = VARIANT_EN[k] || o.label;
    return typeof t === 'function' ? t(`condition_node.op.${k}`, en) : en;
}

function leftFragment(b) {
    if (!b || typeof b !== 'object') return String(b || '').trim();
    if (b.kind === 'literal') return renderBindingValue(b);
    return String((b.kind === 'ref' ? b.path : b.kind === 'expr' ? b.value : '') || '').trim();
}

/** Nothing filled in yet: an explicit `null` is a value (`== null` asks about absence). */
function isBlankValue(v) {
    if (!v || typeof v !== 'object') return v === undefined || v === '';
    if (v.kind === 'literal') return v.value === undefined || v.value === '';
    if (v.kind === 'ref') return !String(v.path || '').trim();
    return !String(v.value ?? '').trim();
}

/** Serialise a single row to an expression fragment, or '' if incomplete. */
export function serializeRow(row) {
    if (!row) return '';
    const op = getOperator(row.op) || OP_BY_KEY.get('eq');
    const left = leftFragment(row.field);
    if (!left) return '';
    if (row.quantifier) return serializeQuantified(row, op, left);
    if (op.kind === 'unary') return op.emit(left);
    if (op.kind === 'topic') return serializeTopic(op, left, row);
    // An unfinished row is never saved as `field == ""`; only a saved one keeps that shape.
    if (isBlankValue(row.value) && !row.keepBlank) return '';
    const rhs = renderBindingValue(row.value);
    if (op.kind === 'fn') return `${op.negate ? '!' : ''}${op.fn}(${left}, ${rhs})`;
    return `${left} ${op.symbol} ${rhs}`;
}

/** `anyOf(item.attachments[*].mimeType, "contains", "pdf")` — every entry of the list checked. */
function serializeQuantified(row, op, left) {
    const unary = UNARY_TESTS.includes(TEST_OF_OP[op.key]);
    if (!unary && isBlankValue(row.value) && !row.keepBlank) return '';
    return quantifiedCall(row.quantifier, left, op.key, unary ? null : renderBindingValue(row.value));
}

/** `isAbout(left, "topic"[, threshold])`; an empty topic still serialises, for the validator. */
function serializeTopic(op, left, row) {
    const topic = row.value?.kind === 'literal' && row.value.value != null ? String(row.value.value).trim() : '';
    const t = Number(row.threshold);
    const cut = Number.isFinite(t) && t > 0 && t < 1 ? `, ${t}` : '';
    return `${op.negate ? '!' : ''}isAbout(${left}, ${JSON.stringify(topic)}${cut})`;
}

/** Rows joined by `join` ('&&'|'||'); incomplete rows dropped; '' when nothing serialises. */
export function serializeRows(rows, join = '&&') {
    const j = join === '||' ? '||' : '&&';
    const frags = (rows || []).map(serializeRow).filter(Boolean);
    return frags.join(` ${j} `);
}

const SYMBOL_TO_KEY = { '==': 'eq', '!=': 'neq', '===': 'seq', '!==': 'sneq', '>=': 'gte', '<=': 'lte', '>': 'gt', '<': 'lt' };
const ref = (path) => ({ kind: 'ref', path });
const blank = () => ({ kind: 'literal', value: '' });

/** Convert a raw right-hand-side token (`"file"`, `1000`, `steps.x.y`) to a binding. */
function valueRawToBinding(rawText) {
    const trimmed = String(rawText ?? '').trim();
    if (/^(true|false|null)$/.test(trimmed)) return { kind: 'literal', value: trimmed === 'null' ? null : trimmed === 'true' };
    if (/^-?\d+(\.\d+)?$/.test(trimmed)) return { kind: 'literal', value: Number(trimmed) };
    if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
        try { return { kind: 'literal', value: JSON.parse(trimmed.replace(/'/g, '"')) }; }
        catch { return { kind: 'literal', value: trimmed.slice(1, -1) }; }
    }
    return bindingFromInput(trimmed, 'expression');
}

/** A binary row read from a saved `x == ""` keeps that shape (see serializeRow). */
function withValue(row, rawText) {
    const value = valueRawToBinding(rawText);
    return isBlankValue(value) ? { ...row, value, keepBlank: true } : { ...row, value };
}

// A clean path (a list column is only a quantified row) or a File type of the item / a field.
function fieldFromLeft(left) {
    const t = String(left || '').trim();
    if (t.startsWith('fileType(')) return fieldShape(t)?.kind === 'fileRecord' ? ref(fieldShape(t).path) : null;
    if (t.includes('[*]')) return null;
    return isCleanPath(t) ? ref(canonicalRefPath(t)) : null;
}

// `[!]name(arg, …)` as a whole fragment, split on top-level commas only.
const CALL_HEAD_RE = /^(!\s*)?(isEmpty|isAbout|contains|startsWith|endsWith|equals)\(/;
function parseCall(text) {
    const head = CALL_HEAD_RE.exec(text);
    const inner = head && splitCallArgs(text, head[0].length);
    // The call's own `)` must end the fragment (`contains(a, b) + 1` is a formula).
    if (!inner || inner.end !== text.length - 1) return null;
    return { negate: !!head[1], fn: head[2], args: inner.args };
}

const QUOTED_RE = /^("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')$/;
const THRESHOLD_RE = /^\d*\.?\d+$/;

/** [!]isAbout(LEFT, "topic"[, 0.7]): a quoted topic, an optional plain-number threshold. */
function topicRow(field, negate, [, topic = '', cut, ...rest]) {
    if (rest.length || !QUOTED_RE.test(topic) || (cut !== undefined && !THRESHOLD_RE.test(cut))) return null;
    const row = { field, op: negate ? 'notAbout' : 'isAbout', value: valueRawToBinding(topic) };
    return cut ? { ...row, threshold: Number(cut) } : row;
}

/** The legacy `contains(item.l[*].c, v)` / `!contains(…)`: "any" / "no" entry contains v. */
function legacyColumnRow({ negate, fn, args }) {
    const shape = fn === 'contains' && args.length === 2 && args[1] ? fieldShape(args[0]) : null;
    if (shape?.kind !== 'column') return null;
    return withValue({ field: ref(shape.path), op: 'contains', quantifier: negate ? 'none' : 'any' }, args[1]);
}

/** A row for a recognised helper call (is, is empty, is about, contains, …), or null. */
function rowFromCall(call) {
    const { negate, fn, args } = call;
    const f = fieldFromLeft(args[0]);
    if (!f) return legacyColumnRow(call);
    if (fn === 'isEmpty') return args.length === 1 ? { field: f, op: negate ? 'isNotEmpty' : 'isEmpty', value: blank() } : null;
    if (fn === 'isAbout') return topicRow(f, negate, args);
    if (args.length !== 2 || !args[1]) return null;
    if (fn === 'equals') return withValue({ field: f, op: negate ? 'isNot' : 'is' }, args[1]);
    // contains/startsWith/endsWith(LEFT, RHS); only contains has a negated operator.
    if (negate && fn !== 'contains') return null;
    return withValue({ field: f, op: negate ? 'notContains' : fn }, args[1]);
}

/** `anyOf(<column or File type of a list>, "<test>"[, value])` → a quantified row. */
function quantifiedRow(q) {
    const shape = fieldShape(q.left);
    if (shape?.kind !== 'column' && shape?.kind !== 'fileList') return null;
    const row = { field: ref(shape.path), op: q.op, quantifier: q.quantifier };
    return q.rhs == null ? { ...row, value: blank() } : withValue(row, q.rhs);
}

function rowFromComparator(cmp) {
    const f = fieldFromLeft(cmp.left);
    if (!f) return null;
    // `x == true` / `x == false` are the unary boolean forms.
    if (cmp.op === 'eq' && (cmp.right === 'true' || cmp.right === 'false')) {
        return { field: f, op: cmp.right === 'true' ? 'isTrue' : 'isFalse', value: blank() };
    }
    return withValue({ field: f, op: cmp.op }, cmp.right);
}

/** Parse one fragment into a row, or null if it isn't a recognised shape. */
function parseFragment(part) {
    const text = part.trim();
    if (!text) return null;
    const quantified = readQuantifiedCall(text);
    if (quantified) return quantifiedRow(quantified);
    const call = parseCall(text);
    if (call) return rowFromCall(call);
    const cmp = parseComparator(text);
    if (cmp) return rowFromComparator(cmp);
    // A bare field, no operator: "has a value" (`[*]` allowed — "is this list
    // non-empty" is a whole-value check). A bare true/false/null is not a field.
    if (!/^(true|false|null)$/.test(text) && isCleanPath(text)) {
        return { field: ref(canonicalRefPath(text)), op: 'truthy', value: blank() };
    }
    return null;
}

const CMP_SYMBOLS = ['===', '!==', '==', '!=', '>=', '<=', '>', '<'];
const OP_CHARS = new Set(['=', '!', '<', '>']);
function parseComparator(text) {
    for (const sym of CMP_SYMBOLS) {
        const idx = findTopLevelSymbol(text, sym);
        if (idx === -1) continue;
        const before = idx > 0 ? text[idx - 1] : ' ';
        const after = idx + sym.length < text.length ? text[idx + sym.length] : ' ';
        if (OP_CHARS.has(before) || OP_CHARS.has(after)) continue;
        const left = text.slice(0, idx).trim();
        const right = text.slice(idx + sym.length).trim();
        if (!left || !right) return null;
        return { left, op: SYMBOL_TO_KEY[sym], right };
    }
    return null;
}

/** `{ rows, join }` for the clickable builder, or null when the expression is a formula. */
export function parseExprToRows(expr) {
    if (typeof expr !== 'string' || !expr.trim()) return null;
    const split = splitTopLevel(expr.trim());
    if (!split) return null;
    const rows = [];
    for (const part of split.parts) {
        const row = parseFragment(part);
        if (!row) return null;
        rows.push(row);
    }
    if (!rows.length) return null;
    return { rows, join: split.join };
}

/** A blank row for the "add condition" affordance. */
export const emptyRow = () => ({ field: ref(''), op: 'is', value: blank() });

const isQuantifiedShape = (shape) => shape?.kind === 'column' || shape?.kind === 'fileList';
const rowPath = (row) => (row?.field?.kind === 'ref' ? String(row.field.path || '') : '');

/** The datatype a row compares (a column: its first entry's; File type: 'fileType'). `walk(path, root)` reads the sample. */
export function rowType(row, sampleRoot, walk) {
    const path = rowPath(row);
    const shape = path ? fieldShape(path) : null;
    if (shape?.kind === 'fileRecord' || shape?.kind === 'fileList') return 'fileType';
    if (!path || sampleRoot == null || typeof walk !== 'function') return 'unknown';
    const value = walk(path, sampleRoot);
    if (shape?.kind === 'column') return inferType(Array.isArray(value) ? value.find((v) => v != null) : value);
    return inferType(value);
}

/** The row with a new field of `type`: an operator not offered resets; a column gets "any". */
export function rowForField(row, field, type) {
    const quantified = isQuantifiedShape(field?.kind === 'ref' ? fieldShape(String(field.path || '')) : null);
    const offered = operatorsForType(type, null, { quantified }).map((o) => o.key);
    const keepsTopic = isTopicOp(row?.op) && TOPIC_TYPES.has(type) && !quantified;
    const { quantifier: _q, keepBlank: _k, ...rest } = row || emptyRow();
    const op = offered.includes(rest.op) || keepsTopic ? rest.op : offered[0];
    // R2: a value typed for another field never becomes a File type ("pdf" from
    // a Mime type row would pick PDF unasked), nor a File type key a text value.
    if (isFileTypePath(field) !== isFileTypePath(rest.field)) rest.value = blank();
    return quantified ? { ...rest, field, op, quantifier: 'any' } : { ...rest, field, op };
}

const isFileTypePath = (binding) => binding?.kind === 'ref' && String(binding.path || '').startsWith('fileType(');

// "no attachment is a PDF" on each attachment reads "is not a PDF".
const NEGATED = {
    is: 'isNot', isNot: 'is', eq: 'neq', neq: 'eq', contains: 'notContains', notContains: 'contains',
    isEmpty: 'isNotEmpty', isNotEmpty: 'isEmpty', gt: 'lte', lte: 'gt', gte: 'lt', lt: 'gte',
};

/** A quantified row over `list`, re-rooted on the list's own entry; null when it cannot be. */
function rowOnEntry(row, shape, list) {
    if (!row.quantifier || !isQuantifiedShape(shape) || canonicalRefPath(shape.list) !== list) return null;
    const head = `${list}[*]`;
    if (shape.kind === 'column' && !shape.path.startsWith(head)) return null;
    const path = shape.kind === 'fileList' ? 'fileType(item)' : `item${shape.path.slice(head.length)}`;
    const { quantifier, ...rest } = row;
    if (quantifier !== 'none') return { ...rest, field: ref(path) };
    return NEGATED[rest.op] ? { ...rest, field: ref(path), op: NEGATED[rest.op] } : null;
}

/** Does this field read a key of the (old) item? `fileType(item)` reads the item itself. */
const readsItemKey = (path) => ['item.', 'item[', 'fileType(item.', 'fileType(item['].some((head) => path.startsWith(head));

/**
 * Rows after the list moved one level in (L → L[*].<listKey>): rows quantified over
 * `item.<listKey>` become rows on the entry; rows reading another field of the old
 * item are kept and their field paths returned in `unfit` (named, offered for removal).
 */
export function deepenRows(rows, listKey) {
    const list = appendKey('item', listKey);
    const out = [];
    const unfit = [];
    for (const row of rows || []) {
        const path = rowPath(row);
        const moved = path ? rowOnEntry(row, fieldShape(path), list) : null;
        if (moved) { out.push(moved); continue; }
        out.push(row);
        if (path && readsItemKey(path) && !unfit.includes(path)) unfit.push(path);
    }
    return { rows: out, unfit };
}
