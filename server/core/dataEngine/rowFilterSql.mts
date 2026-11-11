/**
 * ROW-LEVEL-SECURITY: a row rule → bounded, parameterised SQL.
 *
 * Moved out of accessFilter.js, which holds the description of the whole
 * (scopes, the grammar, the three answers of an attribute that was not
 * supplied) and re-exports everything here; callers keep requiring that.
 *
 *   rowFilterToSql(astOrExpr, viewer, tableMeta, opts?) → { sql, params }
 *
 * Everything outside the subset throws AccessError(400): validateRowFilter
 * (rowFilterCheck.mts) at save time, a defensive throw at compile time. No
 * value is ever emitted unparameterised.
 */

import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);

type ViewerAttributeSpec = { key: string; list?: boolean };
const { SYSTEM_COLUMNS, VIEWER_ATTRIBUTES } = nodeRequire('./dataModel/vocabulary') as {
    SYSTEM_COLUMNS: readonly string[]; VIEWER_ATTRIBUTES: readonly ViewerAttributeSpec[];
};
// Dialect (sqlite | pg) for the emitted predicates. The ONLY dialect-sensitive
// spots here are the two boolean BINDS below (sqlite stores bools as 0/1 and
// better-sqlite3 refuses raw booleans; pg's BOOLEAN columns want true/false).
const { resolveDialect } = nodeRequire('./engineFlag') as { resolveDialect(opts?: unknown): string };
// The shared, isomorphic expression engine — required directly rather than
// through automation/expr.js, which is only a CommonJS re-export of it.
// shared/ is platform, so this edge points downward.
const { parseExpr } = nodeRequire('../../shared/expr/index.mjs') as {
    parseExpr(src: string, opts?: { membership?: boolean }): RowFilterNode;
};

/** A shared-expr AST node, as far as the row-filter subset reads it. */
export type RowFilterNode = {
    kind: string; op?: string; v?: unknown; a?: RowFilterNode; b?: RowFilterNode;
    segments?: { kind: string; v?: string }[];
};
type Field = { key?: string; type?: string; computed?: { stored?: boolean } | null };
/** The parts of a table descriptor a row rule reads. */
export type RuleTableMeta = { fields?: (Field | null)[] | null } | null | undefined;
export type Viewer = Record<string, unknown> | null | undefined;
type Params = unknown[];
/** What one translation carries along. */
type Ctx = { viewer: Viewer; tableMeta: RuleTableMeta; params: Params; dialect: string };

/** A 403-style (or 400 validation) access failure. */
export class AccessError extends Error {
    status: number;

    constructor(message: string, status = 403) {
        super(message);
        this.name = 'AccessError';
        this.status = status;
    }
}

export function qi(name: unknown): string {
    return '"' + String(name).replaceAll('"', '""') + '"';
}

// ── Row filter → parameterised SQL ──────────────────────────────────

const CMP: Record<string, string> = { '==': '=', '===': '=', '!=': '!=', '!==': '!=', '<': '<', '<=': '<=', '>': '>', '>=': '>=' };
const LOGIC: Record<string, string> = { '&&': 'AND', '||': 'OR' };

export function reject(message: string): AccessError {
    return new AccessError(message, 400);
}

export function normalizeAst(x: unknown): RowFilterNode {
    if (typeof x === 'string') return parseExpr(x, { membership: true }); // ExprError on bad grammar
    if (x && typeof x === 'object' && typeof (x as RowFilterNode).kind === 'string') return x as RowFilterNode;
    throw reject('row filter must be an expression string or AST');
}

function findField(tableMeta: RuleTableMeta, fieldName: string): Field | null {
    const fields = Array.isArray(tableMeta && tableMeta.fields) ? (tableMeta as { fields: (Field | null)[] }).fields : [];
    return fields.find((x) => !!x && x.key === fieldName) ?? null;
}

function resolveRowFilterColumn(tableMeta: RuleTableMeta, fieldName: string): string {
    if (SYSTEM_COLUMNS.includes(fieldName)) return qi(fieldName);
    const f = findField(tableMeta, fieldName);
    if (!f) throw reject(`unknown field "${fieldName}" in row filter`);
    if (f.type === 'computed' && !(f.computed && f.computed.stored === true)) {
        throw reject(`read-time computed field "${fieldName}" cannot be used in a row filter`);
    }
    return qi(f.key);
}

function bindViewerValue(val: unknown, dialect: string): unknown {
    if (val === null || val === undefined) return null;
    const t = typeof val;
    if (t === 'string' || t === 'number') return val;
    if (t === 'boolean') return dialect === 'pg' ? val : (val ? 1 : 0);
    throw reject('viewer attribute must be a scalar');
}

// A record.<field> or viewer.<attr> path — exactly two plain name segments.
function translatePath(node: RowFilterNode, ctx: Ctx): string {
    const segs = node.segments;
    if (!Array.isArray(segs) || segs.length !== 2) {
        throw reject('row filter paths must be record.<field> or viewer.<attr>');
    }
    const [root, leaf] = segs;
    if (root.kind !== 'name' || leaf.kind !== 'name') {
        throw reject('computed / bracket access is not allowed in a row filter');
    }
    const name = String(leaf.v);
    if (root.v === 'record') return resolveRowFilterColumn(ctx.tableMeta, name);
    if (root.v === 'viewer') {
        // A list attribute outside `in` is refused when the rule is saved
        // (rowFilterCheck.mts). Here it binds NULL, as an attribute nobody supplied
        // always has: a read never fails on it and never matches on it.
        const supplied = !!ctx.viewer && Object.hasOwn(ctx.viewer, name) && !LIST_ATTRIBUTES.has(name);
        ctx.params.push(bindViewerValue(supplied ? (ctx.viewer as Record<string, unknown>)[name] : null, ctx.dialect));
        return '?';
    }
    throw reject(`unknown root "${root.v}" in row filter (only record.* and viewer.* are allowed)`);
}

// ── Membership: record.<field> in viewer.<list attribute> ───────────

export const LIST_ATTRIBUTES: ReadonlySet<string> = new Set(VIEWER_ATTRIBUTES.filter((spec) => spec.list === true).map((spec) => spec.key));
export const KNOWN_ATTRIBUTES: ReadonlySet<string> = new Set(VIEWER_ATTRIBUTES.map((spec) => spec.key));
// A list holds text, so the column it is tested against holds text too. A
// number or date column would make Postgres type the bound items after the
// column and fail the whole read on the first group id.
const MEMBERSHIP_FIELD_TYPES: ReadonlySet<string> = new Set(['text', 'richtext', 'select']);
const MEMBERSHIP_SYSTEM_COLUMNS: ReadonlySet<string> = new Set(['id', 'created_by', 'org_id']);

/** The two plain names of a `root.leaf` path, or null. */
export function plainPath(node: RowFilterNode | null | undefined): { root: string; leaf: string } | null {
    const segs = node && node.kind === 'path' && Array.isArray(node.segments) ? node.segments : null;
    if (!segs || segs.length !== 2 || segs[0].kind !== 'name' || segs[1].kind !== 'name') return null;
    return { root: String(segs[0].v), leaf: String(segs[1].v) };
}

function membershipColumn(node: RowFilterNode | undefined, tableMeta: RuleTableMeta): string {
    const p = plainPath(node);
    if (!p || p.root !== 'record') throw reject('the left side of "in" must be record.<field>');
    const column = resolveRowFilterColumn(tableMeta, p.leaf);
    if (SYSTEM_COLUMNS.includes(p.leaf)) {
        if (!MEMBERSHIP_SYSTEM_COLUMNS.has(p.leaf)) throw reject(`"${p.leaf}" cannot be tested with "in": it does not hold text`);
        return column;
    }
    if (!MEMBERSHIP_FIELD_TYPES.has(String(findField(tableMeta, p.leaf)?.type))) {
        throw reject(`field "${p.leaf}" cannot be tested with "in": only a text or select field can`);
    }
    return column;
}

function membershipAttribute(node: RowFilterNode | undefined): string {
    const p = plainPath(node);
    if (!p || p.root !== 'viewer' || !LIST_ATTRIBUTES.has(p.leaf)) {
        throw reject(`the right side of "in" must be a list of the viewer: ${[...LIST_ATTRIBUTES].map((k) => `viewer.${k}`).join(', ')}`);
    }
    return p.leaf;
}

function translateMembership(node: RowFilterNode, ctx: Ctx): string {
    const attr = membershipAttribute(node.b);
    const column = membershipColumn(node.a, ctx.tableMeta);
    const raw = (ctx.viewer && Object.hasOwn(ctx.viewer, attr)) ? ctx.viewer[attr] : undefined;
    if (!Array.isArray(raw)) return `(${column} IN (NULL))`; // not supplied: unknown
    const items = raw.filter((v) => typeof v === 'string' && v !== '');
    if (!items.length) return '(1=0)'; // supplied and empty: false
    ctx.params.push(...items);
    return `(${column} IN (${items.map(() => '?').join(', ')}))`;
}

// An operand: a column ref, a bound viewer param, or a bound literal.
function translateOperand(node: RowFilterNode | undefined, ctx: Ctx): string {
    if (!node || typeof node !== 'object') throw reject('bad row filter operand');
    switch (node.kind) {
        case 'num': ctx.params.push(node.v); return '?';
        case 'str': ctx.params.push(node.v); return '?';
        case 'bool': ctx.params.push(ctx.dialect === 'pg' ? node.v : (node.v ? 1 : 0)); return '?';
        case 'path': return translatePath(node, ctx);
        default: throw reject(`"${node.kind}" is not allowed as a row filter operand`);
    }
}

function translateBinop(node: RowFilterNode, ctx: Ctx): string {
    const op = String(node.op);
    if (Object.hasOwn(LOGIC, op)) {
        const a = translate(node.a, ctx);
        const b = translate(node.b, ctx);
        return `(${a} ${LOGIC[op]} ${b})`;
    }
    if (op === 'in') return translateMembership(node, ctx);
    if (Object.hasOwn(CMP, op)) {
        const a = translateOperand(node.a, ctx);
        const b = translateOperand(node.b, ctx);
        return `(${a} ${CMP[op]} ${b})`;
    }
    throw reject(`operator "${op}" is not allowed in a row filter`);
}

// A boolean sub-expression: comparison, &&/||, ! or a bare truthy column/literal.
function translate(node: RowFilterNode | undefined, ctx: Ctx): string {
    if (!node || typeof node !== 'object') throw reject('empty row filter node');
    switch (node.kind) {
        case 'binop':
            return translateBinop(node, ctx);
        case 'unop':
            if (node.op === '!') return `(NOT ${translate(node.a, ctx)})`;
            throw reject(`unary "${node.op}" is not allowed in a row filter`);
        case 'path':
        case 'num':
        case 'str':
        case 'bool':
            return translateOperand(node, ctx);
        default:
            throw reject(`"${node.kind}" is not allowed in a row filter`);
    }
}

/**
 * Translate a row filter (shared-expr AST or string) into bounded, parameterised
 * SQL. Throws AccessError on any node outside the supported subset.
 */
export function rowFilterToSql(astOrExpr: unknown, viewer?: Viewer, tableMeta?: RuleTableMeta, opts: unknown = {}): { sql: string; params: Params } {
    const ctx: Ctx = { viewer: viewer || {}, tableMeta, params: [], dialect: resolveDialect(opts) };
    const sql = translate(normalizeAst(astOrExpr), ctx);
    return { sql, params: ctx.params };
}
