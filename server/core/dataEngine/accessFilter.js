// @typecheck
/**
 * ROW-LEVEL-SECURITY — the access-filter compiler.
 *
 * The gateway decides WHO a viewer is (their role in an app) and WHAT rows they
 * may touch (an access predicate the query compiler ANDs into every query). It
 * is the second half of the security core: the compiler proves no client SQL
 * ever runs; the gateway proves every compiled query is scoped to the viewer.
 *
 *   compileAccessFilter(tableMeta, role, viewer, action, opts?) → { where, params }
 *   assertCanWrite(tableMeta, role, action) → scope | throws {status:403}
 *   rowFilterToSql(astOrExpr, viewer, tableMeta, opts?) → { sql, params }
 *   validateRowFilter(ruleOrPerOperation, tableMeta) → { ok, errors, warnings }
 *
 * ── SCOPES ──────────────────────────────────────────────────────────
 * A (role, action) resolves to a scope:
 *   read/update/delete → 'none' | 'own' | 'all'
 *   create             → boolean
 * translated to a base WHERE fragment:
 *   none → 1=0 (deny), own → created_by = ?viewer, all → 1=1
 * PLUS `AND (rowFilterSql)` when the table declares access.rowFilters[role].
 * That entry is ONE rule (a string or an AST) for read, update and delete alike,
 * or an object `{ read?, update?, delete? }` with a rule per operation; an
 * operation it leaves out has no row rule. One rule compiles exactly as before.
 * The app OWNER is always 'all' and skips row filters (full access).
 * `create` has no rows to filter, so compileAccessFilter THROWS on it; the
 * create permission is answered by assertCanWrite alone.
 *
 * ── ROW FILTER → SQL (bounded, parameterised) ───────────────────────
 * A row filter is a shared-expr AST/string. rowFilterToSql walks a SMALL, SAFE
 * subset and emits parameterised SQL:
 *   comparisons  ==,===,!=,!==,<,<=,>,>=   →  =,=,!=,!=,<,<=,>,>=
 *   logic        &&,||                      →  AND, OR
 *   unary        !                          →  NOT (...)
 *   record.<field>                          →  the quoted real column (via tableMeta)
 *   viewer.<attr>                           →  a BOUND ? param from the viewer object
 *   literals     string / number / bool     →  BOUND ? params
 *   record.<field> in viewer.<list>         →  column IN (?, ?, …), every item BOUND
 *       (the list attributes are in dataModel/vocabulary VIEWER_ATTRIBUTES)
 *
 * THREE ANSWERS, NOT TWO. A viewer attribute the caller did not supply is
 * UNKNOWN, and unknown must never become "yes" by way of a `!`. A missing
 * scalar binds NULL (`x = NULL` is neither true nor false, and neither is its
 * negation). A missing list compiles to `column IN (NULL)`, unknown the same
 * way. Only a list that WAS supplied and is empty is a plain false (`1=0`):
 * someone in no group is in none of them, and "not in any of mine" is then true.
 * ANYTHING else — function calls, arithmetic (+ - * / %), bracket/computed
 * access, unknown roots, ternaries, null — is REJECTED (validateRowFilter at
 * save time; a defensive throw at compile time). No value is ever emitted
 * unparameterised.
 *
 * ── THE PREDICATE IS NOT A WRITE-PERMISSION CHECK ───────────────────
 * Read this before building anything on the belief that the ANDed predicate is
 * a second line of defence for writes. It answers ONE question — which ROWS is
 * this (role, action) allowed to address — from the table descriptor's `access`
 * block alone. It knows nothing about grades, and it is not a veto.
 *
 * How much it distinguishes therefore depends entirely on that block. A
 * datatable's block comes from auth/datatableAccess.synthesizeAccess, which
 * does give `viewer` `update:'none'` → `1=0`. An App Studio table created with
 * the default `access.default:'app'` gives EVERY role `1=1` for update and
 * delete, because 'app' means "everyone who can open the app". Same function,
 * opposite answer, and only the descriptor decides.
 *
 * So the thing that actually stops a low grade writing is the coarse check —
 * `gradeAtLeast` in routes/datatables.js and in the runner, and assertCanWrite
 * here. Making the predicate itself grade-aware is a separate ticket with its
 * own test matrix; until then, never remove a gradeAtLeast on the grounds that
 * "the filter covers it".
 *
 * ── LAYER ───────────────────────────────────────────────────────────
 * core/. Everything here is a pure function of a table descriptor, a role, a
 * viewer object and an action — it has no idea what an "app" is. App Studio and
 * automation datatables both need it, and server/layering.test.js forbids one
 * feature requiring another, so it lives here and appStudio/rlsGateway.js is a
 * shim over it. The one genuinely App-Studio-shaped function, resolveViewerRole
 * (it reads studio_app_members and model.roleMapping), stayed behind in that
 * shim; a datatable resolves its role from the organisation instead.
 */

'use strict';

const { SYSTEM_COLUMNS, PUBLIC_ROLE_KEY, VIEWER_ATTRIBUTES, ROW_FILTER_OPERATIONS } = require('./dataModel/vocabulary');
// Dialect (sqlite | pg) for the emitted predicates. The ONLY dialect-sensitive
// spots here are the two boolean BINDS below (sqlite stores bools as 0/1 and
// better-sqlite3 refuses raw booleans; pg's BOOLEAN columns want true/false).
// The '1=1' / '1=0' scope fragments are valid Postgres as-is and stay.
const { resolveDialect } = require('./engineFlag');
// The shared, isomorphic expression engine — required directly rather than
// through automation/expr.js, which is only a CommonJS re-export of it.
// shared/ is platform, so this edge points downward.
const { parseExpr } = require('../../shared/expr/index.mjs');

/** A 403-style (or 400 validation) access failure. */
class AccessError extends Error {
    /**
     * @param {string} message
     * @param {number} [status]
     */
    constructor(message, status = 403) {
        super(message);
        this.name = 'AccessError';
        this.status = status;
    }
}

/**
 * @param {string} name
 */
function qi(name) {
    return '"' + String(name).replace(/"/g, '""') + '"';
}

// ── Scope resolution ────────────────────────────────────────────────

const READ_WRITE_SCOPES = new Set(['none', 'own', 'all']);

function normalizePerm(v, action) {
    if (action === 'create') return v === true || v === 'all' || v === 'own';
    if (READ_WRITE_SCOPES.has(v)) return v;
    if (v === true) return 'all';
    if (v === false) return 'none';
    return 'none';
}

// The table's default access mode (dataModel ACCESS_MODES) → a per-action scope
// when a role has no explicit entry.
function defaultScope(mode, action) {
    switch (mode) {
        case 'app': return action === 'create' ? true : 'all';
        case 'owner': return action === 'create' ? true : 'own';
        case 'role': return action === 'create' ? false : 'none';
        case 'none': return action === 'create' ? false : 'none';
        default: return action === 'create' ? false : 'none';
    }
}

/**
 * The effective scope for (role, action). Owner is always full. A role's
 * explicit access.roles[role][action] wins; otherwise the table's
 * access.default applies. Unknown/absent role → deny.
 */
function resolveScope(tableMeta, role, action) {
    if (role === 'owner') return action === 'create' ? true : 'all';
    if (!role) return action === 'create' ? false : 'none';
    const access = (tableMeta && typeof tableMeta.access === 'object' && tableMeta.access) ? tableMeta.access : {};
    const roles = (access.roles && typeof access.roles === 'object') ? access.roles : {};
    const entry = Object.hasOwn(roles, role) ? roles[role] : null;
    if (entry && typeof entry === 'object' && Object.hasOwn(entry, action)) {
        return normalizePerm(entry[action], action);
    }
    // The anonymous role NEVER inherits access.default. A table is created with
    // default 'app' — "everyone who can open the app may read every row" — which
    // is a sound default for colleagues and catastrophic for the open internet:
    // one public intake screen would have handed every visitor the whole
    // customer table. A public page's tables must opt IN, per action.
    if (role === PUBLIC_ROLE_KEY) return action === 'create' ? false : 'none';
    return defaultScope(access.default, action);
}

/** May this (role) READ any rows of this table at all? */
function canRead(tableMeta, role) {
    return resolveScope(tableMeta, role, 'read') !== 'none';
}

// ── Row filter → parameterised SQL ──────────────────────────────────

/** @type {Record<string, string>} */
const CMP = { '==': '=', '===': '=', '!=': '!=', '!==': '!=', '<': '<', '<=': '<=', '>': '>', '>=': '>=' };
/** @type {Record<string, string>} */
const LOGIC = { '&&': 'AND', '||': 'OR' };

/**
 * @param {string} message
 */
function reject(message) {
    return new AccessError(message, 400);
}

function normalizeAst(x) {
    if (typeof x === 'string') return parseExpr(x, { membership: true }); // ExprError on bad grammar
    if (x && typeof x === 'object' && typeof x.kind === 'string') return x;
    throw reject('row filter must be an expression string or AST');
}

function resolveRowFilterColumn(tableMeta, fieldName) {
    if (SYSTEM_COLUMNS.includes(fieldName)) return qi(fieldName);
    const fields = Array.isArray(tableMeta && tableMeta.fields) ? tableMeta.fields : [];
    const f = fields.find((x) => x && x.key === fieldName);
    if (!f) throw reject(`unknown field "${fieldName}" in row filter`);
    if (f.type === 'computed' && !(f.computed && f.computed.stored === true)) {
        throw reject(`read-time computed field "${fieldName}" cannot be used in a row filter`);
    }
    return qi(f.key);
}

function bindViewerValue(val, dialect) {
    if (val === null || val === undefined) return null;
    const t = typeof val;
    if (t === 'string' || t === 'number') return val;
    if (t === 'boolean') return dialect === 'pg' ? val : (val ? 1 : 0);
    throw reject('viewer attribute must be a scalar');
}

// A record.<field> or viewer.<attr> path — exactly two plain name segments.
function translatePath(node, viewer, tableMeta, params, dialect) {
    const segs = node.segments;
    if (!Array.isArray(segs) || segs.length !== 2) {
        throw reject('row filter paths must be record.<field> or viewer.<attr>');
    }
    const [root, leaf] = segs;
    if (root.kind !== 'name' || leaf.kind !== 'name') {
        throw reject('computed / bracket access is not allowed in a row filter');
    }
    if (root.v === 'record') return resolveRowFilterColumn(tableMeta, leaf.v);
    if (root.v === 'viewer') {
        // A list attribute outside `in` is refused when the rule is saved
        // (lintRowFilter). Here it binds NULL, as an attribute nobody supplied
        // always has: a read never fails on it and never matches on it.
        const val = (viewer && Object.hasOwn(viewer, leaf.v) && !LIST_ATTRIBUTES.has(leaf.v)) ? viewer[leaf.v] : null;
        params.push(bindViewerValue(val, dialect));
        return '?';
    }
    throw reject(`unknown root "${root.v}" in row filter (only record.* and viewer.* are allowed)`);
}

// ── Membership: record.<field> in viewer.<list attribute> ───────────

/** @type {ReadonlySet<string>} */
const LIST_ATTRIBUTES = new Set(VIEWER_ATTRIBUTES.filter((spec) => 'list' in spec && spec.list).map((spec) => spec.key));
/** @type {ReadonlySet<string>} */
const KNOWN_ATTRIBUTES = new Set(VIEWER_ATTRIBUTES.map((spec) => spec.key));
// A list holds text, so the column it is tested against holds text too. A
// number or date column would make Postgres type the bound items after the
// column and fail the whole read on the first group id.
const MEMBERSHIP_FIELD_TYPES = new Set(['text', 'richtext', 'select']);
const MEMBERSHIP_SYSTEM_COLUMNS = new Set(['id', 'created_by', 'org_id']);

/** The two plain names of a `root.leaf` path, or null. */
function plainPath(node) {
    const segs = node && node.kind === 'path' && Array.isArray(node.segments) ? node.segments : null;
    if (!segs || segs.length !== 2 || segs[0].kind !== 'name' || segs[1].kind !== 'name') return null;
    return { root: segs[0].v, leaf: segs[1].v };
}

function membershipColumn(node, tableMeta) {
    const p = plainPath(node);
    if (!p || p.root !== 'record') throw reject('the left side of "in" must be record.<field>');
    const column = resolveRowFilterColumn(tableMeta, p.leaf);
    if (SYSTEM_COLUMNS.includes(p.leaf)) {
        if (!MEMBERSHIP_SYSTEM_COLUMNS.has(p.leaf)) throw reject(`"${p.leaf}" cannot be tested with "in": it does not hold text`);
        return column;
    }
    const field = tableMeta.fields.find((x) => x && x.key === p.leaf);
    if (!MEMBERSHIP_FIELD_TYPES.has(field.type)) {
        throw reject(`field "${p.leaf}" cannot be tested with "in": only a text or select field can`);
    }
    return column;
}

function membershipAttribute(node) {
    const p = plainPath(node);
    if (!p || p.root !== 'viewer' || !LIST_ATTRIBUTES.has(p.leaf)) {
        throw reject(`the right side of "in" must be a list of the viewer: ${[...LIST_ATTRIBUTES].map((k) => `viewer.${k}`).join(', ')}`);
    }
    return p.leaf;
}

function translateMembership(node, viewer, tableMeta, params) {
    const attr = membershipAttribute(node.b);
    const column = membershipColumn(node.a, tableMeta);
    const raw = (viewer && Object.hasOwn(viewer, attr)) ? viewer[attr] : undefined;
    if (!Array.isArray(raw)) return `(${column} IN (NULL))`; // not supplied: unknown
    const items = raw.filter((v) => typeof v === 'string' && v !== '');
    if (!items.length) return '(1=0)'; // supplied and empty: false
    params.push(...items);
    return `(${column} IN (${items.map(() => '?').join(', ')}))`;
}

// An operand: a column ref, a bound viewer param, or a bound literal.
function translateOperand(node, viewer, tableMeta, params, dialect) {
    if (!node || typeof node !== 'object') throw reject('bad row filter operand');
    switch (node.kind) {
        case 'num': params.push(node.v); return '?';
        case 'str': params.push(node.v); return '?';
        case 'bool': params.push(dialect === 'pg' ? node.v : (node.v ? 1 : 0)); return '?';
        case 'path': return translatePath(node, viewer, tableMeta, params, dialect);
        default: throw reject(`"${node.kind}" is not allowed as a row filter operand`);
    }
}

// A boolean sub-expression: comparison, &&/||, ! or a bare truthy column/literal.
function translate(node, viewer, tableMeta, params, dialect) {
    if (!node || typeof node !== 'object') throw reject('empty row filter node');
    switch (node.kind) {
        case 'binop': {
            if (Object.hasOwn(LOGIC, node.op)) {
                const a = translate(node.a, viewer, tableMeta, params, dialect);
                const b = translate(node.b, viewer, tableMeta, params, dialect);
                return `(${a} ${LOGIC[node.op]} ${b})`;
            }
            if (node.op === 'in') return translateMembership(node, viewer, tableMeta, params);
            if (Object.hasOwn(CMP, node.op)) {
                const a = translateOperand(node.a, viewer, tableMeta, params, dialect);
                const b = translateOperand(node.b, viewer, tableMeta, params, dialect);
                return `(${a} ${CMP[node.op]} ${b})`;
            }
            throw reject(`operator "${node.op}" is not allowed in a row filter`);
        }
        case 'unop':
            if (node.op === '!') return `(NOT ${translate(node.a, viewer, tableMeta, params, dialect)})`;
            throw reject(`unary "${node.op}" is not allowed in a row filter`);
        case 'path':
        case 'num':
        case 'str':
        case 'bool':
            return translateOperand(node, viewer, tableMeta, params, dialect);
        default:
            throw reject(`"${node.kind}" is not allowed in a row filter`);
    }
}

/**
 * Translate a row filter (shared-expr AST or string) into bounded, parameterised
 * SQL. Throws AccessError on any node outside the supported subset.
 */
function rowFilterToSql(astOrExpr, viewer, tableMeta, opts = {}) {
    const dialect = resolveDialect(opts);
    const ast = normalizeAst(astOrExpr);
    const params = [];
    const sql = translate(ast, viewer || {}, tableMeta, params, dialect);
    return { sql, params };
}

// ── Save-time checks ────────────────────────────────────────────────

/**
 * What the SQL translation cannot say about a rule: a list attribute used as
 * one value (an error: it would never match), and advice about attributes.
 * @param {RowFilterNode | undefined} node
 * @param {{ errors: string[], warnings: string[] }} out
 * @param {boolean} [listAllowed] true for the right side of `in`
 */
function lintRowFilter(node, out, listAllowed = false) {
    if (!node || typeof node !== 'object') return;
    if (node.kind === 'binop' || node.kind === 'unop') {
        lintRowFilter(node.a, out);
        lintRowFilter(node.b, out, node.op === 'in');
        return;
    }
    const p = plainPath(node);
    if (!p || p.root !== 'viewer') return;
    if (LIST_ATTRIBUTES.has(p.leaf)) {
        if (!listAllowed) out.errors.push(`viewer.${p.leaf} is a list: write record.<field> in viewer.${p.leaf}`);
    } else if (p.leaf === 'organizationId') {
        out.warnings.push('viewer.organizationId is not the same value everywhere (the session\'s organisation on data reads, the app\'s in server steps, empty on a public page): use viewer.orgId in a new rule');
    } else if (!KNOWN_ATTRIBUTES.has(p.leaf)) {
        out.warnings.push(`viewer.${p.leaf} is not something a row rule knows about the viewer, so it never matches (known: ${[...KNOWN_ATTRIBUTES].join(', ')})`);
    }
}

/** One rule (string or AST): it must translate, and it must pass the lint. */
function validateOneRule(astOrExpr, tableMeta) {
    /** @type {{ errors: string[], warnings: string[] }} */
    const out = { errors: [], warnings: [] };
    try {
        rowFilterToSql(astOrExpr, {}, tableMeta);
        lintRowFilter(normalizeAst(astOrExpr), out);
    } catch (e) {
        out.errors.push(e instanceof Error ? /** @type {Error} */ (e).message : String(e));
    }
    return out;
}

/** True for `{ read?, update?, delete? }`: an object that is neither an AST nor a list. */
function isPerOperation(entry) {
    return !!entry && typeof entry === 'object' && !Array.isArray(entry) && typeof entry.kind !== 'string';
}

/**
 * The rule of one operation out of a `rowFilters[role]` entry. One rule (a
 * string or an AST) is that rule for every operation; a per-operation object
 * gives the rule under the operation's own key, or none. An object with a key
 * that is not an operation is refused rather than read as "no rule": a typo
 * must not widen a table.
 */
function rowFilterForAction(entry, action) {
    if (!isPerOperation(entry)) return entry;
    const stray = Object.keys(entry).find((k) => !ROW_FILTER_OPERATIONS.includes(k));
    if (stray !== undefined) throw reject(`"${stray}" is not a row rule operation (${ROW_FILTER_OPERATIONS.join(', ')})`);
    return Object.hasOwn(entry, action) ? entry[action] : null;
}

/**
 * Validate a `rowFilters[role]` entry at data-model save time: one rule, or a
 * rule per operation. Returns { ok, errors, warnings }; the save path rejects
 * a model whose entries do not all pass, and may show the warnings. Structural
 * only (an empty probe viewer); it never executes.
 */
function validateRowFilter(entry, tableMeta) {
    if (!isPerOperation(entry)) {
        const one = validateOneRule(entry, tableMeta);
        return { ok: one.errors.length === 0, errors: one.errors, warnings: one.warnings };
    }
    /** @type {string[]} */
    const errors = [];
    /** @type {string[]} */
    const warnings = [];
    const keys = Object.keys(entry);
    if (!keys.length) errors.push(`a rule per operation needs at least one of ${ROW_FILTER_OPERATIONS.join(', ')}`);
    for (const key of keys) {
        if (!ROW_FILTER_OPERATIONS.includes(key)) {
            errors.push(`"${key}" is not a row rule operation (${ROW_FILTER_OPERATIONS.join(', ')})`);
            continue;
        }
        const one = validateOneRule(entry[key], tableMeta);
        errors.push(...one.errors.map((m) => `${key}: ${m}`));
        warnings.push(...one.warnings.map((m) => `${key}: ${m}`));
    }
    return { ok: errors.length === 0, errors, warnings };
}

// ── Access filter compilation ───────────────────────────────────────

/**
 * The access predicate for (role, action) as { where, params }, ready to hand
 * to the query compiler. Base scope (none/own/all) plus the table's row filter
 * for this role, ANDed together and fully parameterised.
 *
 * NOT for 'create' — see the throw below.
 */
function compileAccessFilter(tableMeta, role, viewer, action, opts = {}) {
    // A create has no rows to filter, so there is no honest predicate to emit,
    // and emitting one anyway is what shipped "Add or update a row" as "always
    // add a row": resolveScope answers the BOOLEAN `true` for a create while
    // the where-builder below only recognises the strings 'all'/'own', so every
    // create filter compiled to 1=0 — for owner, editor and viewer alike. The
    // upsert probe carrying it matched nothing, unconditionally, and a nightly
    // automation keyed on an e-mail address grew one duplicate per run for ever.
    // Returning 1=1 instead would only make the next caller's mistake invisible.
    // Use assertCanWrite(tableMeta, role, 'create') for the permission half.
    if (action === 'create') {
        throw new AccessError(
            'a create has no rows to filter — use assertCanWrite(meta, role, \'create\') instead', 400,
        );
    }
    const viewerId = (viewer && viewer.id != null) ? viewer.id : null;
    const scope = resolveScope(tableMeta, role, action);

    /** @type {string} */
    let where;
    let params;
    if (scope === 'all') { where = '1=1'; params = []; }
    else if (scope === 'own') { where = `${qi('created_by')} = ?`; params = [viewerId]; }
    else { where = '1=0'; params = []; } // 'none' → deny

    if (role !== 'owner' && scope !== 'none') {
        const rowFilters = (tableMeta && tableMeta.access && typeof tableMeta.access.rowFilters === 'object')
            ? tableMeta.access.rowFilters : null;
        const ast = rowFilters && role && Object.hasOwn(rowFilters, role) ? rowFilterForAction(rowFilters[role], action) : null;
        if (ast) {
            const rf = rowFilterToSql(ast, viewer || {}, tableMeta, opts);
            where = `(${where}) AND (${rf.sql})`;
            params = [...params, ...rf.params];
        }
    }
    return { where, params };
}

/**
 * Throw a 403 unless (role) may perform a write (create/update/delete) on this
 * table. Returns the resolved scope ('own'/'all' for update/delete, true for
 * create) so the caller can build the matching access filter.
 */
function assertCanWrite(tableMeta, role, action) {
    if (action !== 'create' && action !== 'update' && action !== 'delete') {
        throw new AccessError(`not a write action: ${action}`, 400);
    }
    const scope = resolveScope(tableMeta, role, action);
    const allowed = action === 'create' ? scope === true : (scope === 'own' || scope === 'all');
    if (!allowed) throw new AccessError('You do not have permission to perform this action', 403);
    return scope;
}

module.exports = {
    resolveScope,
    canRead,
    compileAccessFilter,
    assertCanWrite,
    rowFilterToSql,
    validateRowFilter,
    rowFilterForAction,
    AccessError,
};

/**
 * The parts of a table descriptor this module reads.
 * @typedef {{ default?: string, roles?: Record<string, Record<string, string | boolean>>, rowFilters?: Record<string, string | RowFilterNode | { read?: string | RowFilterNode, update?: string | RowFilterNode, delete?: string | RowFilterNode }> }} TableAccess
 * @typedef {{ access?: TableAccess, fields?: { key?: string, type?: string, computed?: { stored?: boolean } }[] }} AccessTableMeta
 * A shared-expr AST node, as far as the row-filter subset reads it.
 * @typedef {{ kind: string, op?: string, v?: unknown, a?: RowFilterNode, b?: RowFilterNode, segments?: { kind: string, v?: string }[] }} RowFilterNode
 */
