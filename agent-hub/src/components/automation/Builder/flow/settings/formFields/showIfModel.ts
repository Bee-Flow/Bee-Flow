import { appendKey } from '@shared/expr/path.mjs';

/**
 * "Only show this question when…" as a picker model, and back.
 *
 * A question's `showIf` is an expression in the restricted shared/expr
 * grammar whose only root is `form` (the answers of EARLIER questions on the
 * same page). The picker covers the shapes people actually need, one
 * condition on one earlier question:
 *
 *   form.q == "v"        is            form.q != "v"       is not
 *   contains(form.q,"v") contains      form.q > 3          greater than
 *   isEmpty(form.q)      is empty      !isEmpty(form.q)    is not empty
 *   form.q < 3           less than
 *
 * Both directions are pure text work: the expression is generated as text
 * (string literals through JSON.stringify, so a quote in a choice cannot break
 * out of its literal) and read back with a strict pattern. Nothing is ever
 * evaluated here. Anything `parseShowIf` cannot read is not an error: the
 * editor shows it as an advanced text box and leaves it untouched.
 */

export type ShowIfOp = 'eq' | 'ne' | 'contains' | 'empty' | 'notEmpty' | 'gt' | 'lt';

export interface ShowIfModel {
    /** The earlier question's binding name. */
    field: string;
    op: ShowIfOp;
    /** What it is compared with, as typed. Unused by `empty` / `notEmpty`. */
    value: string;
}

/** The operators that need no value. */
export const VALUELESS_OPS: readonly ShowIfOp[] = ['empty', 'notEmpty'];

/** The question types a `showIf` may read, and what it can ask of each. */
const TEXT_OPS: ShowIfOp[] = ['eq', 'ne', 'contains', 'empty', 'notEmpty'];
const OPS_BY_TYPE: Record<string, ShowIfOp[]> = {
    text: TEXT_OPS,
    textarea: TEXT_OPS,
    email: TEXT_OPS,
    select: ['eq', 'ne', 'empty', 'notEmpty'],
    radio: ['eq', 'ne', 'empty', 'notEmpty'],
    multiselect: ['contains', 'empty', 'notEmpty'],
    number: ['eq', 'ne', 'gt', 'lt', 'empty', 'notEmpty'],
    date: ['eq', 'ne', 'gt', 'lt', 'empty', 'notEmpty'],
    checkbox: ['eq', 'ne'],
};

/** The operators a question of this type offers; none means it cannot be used. */
export function opsFor(type: string | undefined): ShowIfOp[] {
    return OPS_BY_TYPE[type || 'text'] || [];
}

/** Question types a showIf can read (everything that collects a simple answer). */
export function isConditionable(field: { type?: string; fieldsFrom?: unknown } | null | undefined): boolean {
    return !!field && !field.fieldsFrom && opsFor(field.type).length > 0;
}

const NUMERIC = /^-?\d+(\.\d+)?$/;

/** The literal a value is written as, given the type of the question it is compared with. */
function literal(value: string, type: string | undefined): string {
    if (type === 'checkbox') return value === 'false' ? 'false' : 'true';
    if (type === 'number' && NUMERIC.test(value.trim())) return String(Number(value.trim()));
    return JSON.stringify(String(value));
}

/** Is the model complete enough to write down? */
export function isComplete(model: ShowIfModel | null | undefined): boolean {
    if (!model || !model.field) return false;
    return VALUELESS_OPS.includes(model.op) || String(model.value ?? '').trim() !== '';
}

/**
 * The expression for a model, or '' when it is not complete yet.
 * `type` is the compared question's type (it decides number / boolean / text literals).
 */
export function buildShowIf(model: ShowIfModel | null | undefined, type?: string): string {
    if (!model || !isComplete(model)) return '';
    const ref = appendKey('form', model.field);
    const v = literal(String(model.value ?? ''), type);
    switch (model.op) {
        case 'eq': return `${ref} == ${v}`;
        case 'ne': return `${ref} != ${v}`;
        case 'contains': return `contains(${ref}, ${v})`;
        case 'gt': return `${ref} > ${v}`;
        case 'lt': return `${ref} < ${v}`;
        case 'empty': return `isEmpty(${ref})`;
        case 'notEmpty': return `!isEmpty(${ref})`;
        default: return '';
    }
}

const REF = String.raw`form(?:\.[A-Za-z_][A-Za-z0-9_]*|\["(?:[^"\\]|\\.)*"\])`;
const LIT = String.raw`"(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?|true|false`;
const COMPARE = new RegExp(`^(${REF})\\s*(==|!=|>|<)\\s*(${LIT})$`);
const CONTAINS = new RegExp(`^contains\\(\\s*(${REF})\\s*,\\s*(${LIT})\\s*\\)$`);
const EMPTY = new RegExp(`^(!?)isEmpty\\(\\s*(${REF})\\s*\\)$`);

/** The key a `form.x` / `form["x"]` reference names. */
function refKey(ref: string): string {
    if (ref.startsWith('form.')) return ref.slice(5);
    try {
        return String(JSON.parse(ref.slice(5, -1)));
    } catch {
        return '';
    }
}

/** A literal as the text the picker shows: strings unquoted, numbers and booleans as written. */
function literalText(lit: string): string | null {
    if (lit.startsWith('"')) {
        try {
            return String(JSON.parse(lit));
        } catch {
            return null;
        }
    }
    return lit;
}

/**
 * Read an expression back into the picker. Returns null for anything that is
 * not exactly one of the shapes above, or that names a question not in
 * `earlier` (a removed or later question cannot be picked, so it stays text).
 */
export function parseShowIf(src: string | null | undefined, earlier: readonly string[]): ShowIfModel | null {
    const text = String(src ?? '').trim();
    if (!text) return null;
    const known = (field: string) => !!field && earlier.includes(field);

    const empty = EMPTY.exec(text);
    if (empty) {
        const field = refKey(empty[2] as string);
        return known(field) ? { field, op: empty[1] ? 'notEmpty' : 'empty', value: '' } : null;
    }
    const contains = CONTAINS.exec(text);
    if (contains) {
        const field = refKey(contains[1] as string);
        const value = literalText(contains[2] as string);
        return known(field) && value !== null ? { field, op: 'contains', value } : null;
    }
    const cmp = COMPARE.exec(text);
    if (cmp) {
        const field = refKey(cmp[1] as string);
        const value = literalText(cmp[3] as string);
        const op: ShowIfOp = ({ '==': 'eq', '!=': 'ne', '>': 'gt', '<': 'lt' } as const)[cmp[2] as '==' | '!=' | '>' | '<'];
        return known(field) && value !== null ? { field, op, value } : null;
    }
    return null;
}

/** The plain-language name of an operator. */
export const OP_LABELS: Record<ShowIfOp, string> = {
    eq: 'is',
    ne: 'is not',
    contains: 'contains',
    empty: 'is empty',
    notEmpty: 'is not empty',
    gt: 'is greater than',
    lt: 'is less than',
};
