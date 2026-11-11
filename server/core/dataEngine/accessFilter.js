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
 *   validateRowFilter(ruleOrPerOperation, tableMeta) → { ok, errors }
 *   rowFilterWarnings(ruleOrPerOperation, tableMeta) → string[] (advice, never a refusal)
 *   canReadField(tableMeta, role, fieldKey) / canWriteField(…) → boolean (column rights)
 *
 * ── COLUMN RIGHTS ───────────────────────────────────────────────────
 * A field may list the roles that read it and the roles that write it
 * (`field.access`, columnRights.mts, where the rules and the enforcement are
 * described). For a table that declares any, the access filter also carries
 * `columns`: what this role may not read or write. The query compilers scope
 * the table with it, and refuse such a table under a filter without one. A
 * table without column rights gets exactly `{ where, params }`, as before.
 * Another read feature asks `canReadField(tableMeta, role, fieldKey)`.
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
 * operation it leaves out follows the rule for read (never broader than read
 * by omission), and `true` is the rule for every row. One rule compiles
 * exactly as before.
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
 * ── FILES ───────────────────────────────────────────────────────────
 * The translation of a rule lives in rowFilterSql.mts, the save-time checks and
 * the choice of a rule per operation in rowFilterCheck.mts. This module holds
 * the scopes and the access predicate, and exports all of it.
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

const { PUBLIC_ROLE_KEY } = require('./dataModel/vocabulary');
const { AccessError, qi, rowFilterToSql } = require('./rowFilterSql.mts');
const { validateRowFilter, rowFilterWarnings, rowFilterForAction } = require('./rowFilterCheck.mts');
const { columnRightsFor, canReadField, canWriteField, OWNER_ACCESS } = require('./columnRights.mts');

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
    // Column rights ride on the predicate, only for a table that declares them.
    const columns = columnRightsFor(tableMeta, role);
    return columns ? { where, params, columns } : { where, params };
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
    rowFilterWarnings,
    rowFilterForAction,
    canReadField,
    canWriteField,
    columnRightsFor,
    OWNER_ACCESS,
    AccessError,
};

/**
 * The parts of a table descriptor this module reads.
 * @typedef {{ default?: string, roles?: Record<string, Record<string, string | boolean>>, rowFilters?: Record<string, string | RowFilterNode | { read?: string | RowFilterNode, update?: string | RowFilterNode, delete?: string | RowFilterNode }> }} TableAccess
 * @typedef {{ access?: TableAccess, fields?: { key?: string, type?: string, computed?: { stored?: boolean }, access?: { read?: string[], write?: string[] } }[] }} AccessTableMeta
 * A shared-expr AST node, as far as the row-filter subset reads it.
 * @typedef {{ kind: string, op?: string, v?: unknown, a?: RowFilterNode, b?: RowFilterNode, segments?: { kind: string, v?: string }[] }} RowFilterNode
 */
