/**
 * THE SHARED DATATABLE RUNNER: "read/write this table, as this person, and only these columns".
 *
 * Until now there were two places that opened a datatable for a principal:
 * `routes/datatables.js` (the Studio UI, via `requireDatatableGrade` + `metaAndFilter`) and
 * `core/automationRunner/datatableResolve.js` (the runner). Every NEW consumer (the web page
 * bridge here, and later the datatable branch of App Studio, P3) would be a third copy of the
 * same two decisions: in which tenant does the table live, and which grade does this person have
 * on it. A copy of an authorisation decision is exactly the kind of code that drifts apart
 * without anyone noticing, so that copy does not come into existence: this is the ONE place that
 * the compiler calls on behalf of a consumer.
 *
 * ── THREE RULES THAT ARE HARD HERE ──────────────────────────────────
 *
 * 1. THE TENANT IS NEVER GUESSED. The table is looked up in the scopes that
 *    `datatableScopesFor(principal)` yields: the organisation of the person and his
 *    own account, and nowhere else. Not a global search checked afterwards.
 *
 * 2. THE GRADE IS RECALCULATED EVERY TIME from the table row plus its grants
 *    (`gradeForPrincipal`). No cache, no passed-in grade: a grant revoked yesterday must
 *    stop working today.
 *
 * 3. `allowColumns` IS REQUIRED AND HAS NO "ALL" VALUE. Every read and write call names
 *    explicitly which column keys the consumer may see. The EMPTY list means NO column (403),
 *    not "all": this is the same agreement that `normalizeBridgeGrants` makes on the storage
 *    side, and whoever writes `columns.length ? columns : ALL` here reverses the narrowing in
 *    one line. A missing `allowColumns` is a programming error and throws loudly, because
 *    silently returning "everything" is precisely the leak this parameter must prevent.
 *
 * The column list also bounds FILTERING and SORTING, not only the projection. Otherwise a page
 * could filter on a column it may not read and extract the value bit by bit. An oracle is just
 * as much a leak as a column in the output. `search` (free search over all text columns) is not
 * offered at all, for the same reason.
 *
 * ── WHAT IS NOT IN HERE ─────────────────────────────────────────────
 * Everything about the REQUEST: authentication, rate limits, which binding is in
 * `bridge_grants`, and whether the reader is public or logged in. That last one is deliberately
 * not a parameter: a public reader never comes through here (see services/webpageSnapshot.js:
 * /w/<slug> is a static snapshot), and a flag "public" would invite someone to set it to false
 * one day.
 *
 * LAYER: core/. May use stores/ and auth/ (platform), knows no feature.
 */

'use strict';

const queryCompiler = require('./queryCompiler');
const accessFilter = require('./accessFilter');
const datatableStore = require('../../stores/datatableStore');
const datatableDbStore = require('../../stores/datatableDbStore');
const log = require('../../telemetry/log');
const {
    gradeForPrincipal, gradeAtLeast, datatableScopesFor, synthesizeAccess,
} = require('../../auth/datatableAccess');
const { bestEffort } = require('../../utils/bestEffort');

const PG = { dialect: 'pg' };

/** Bovengrens per pagina — dezelfde als `ROWS_PAGE_MAX` in routes/datatables.js. */
const ROWS_PAGE_MAX = 500;

/**
 * The fields that ALWAYS come along, next to the bound columns: the envelope with which a row
 * can be addressed. `id` to name a row, `updated_at` because a change without `expectedUpdatedAt`
 * is last-write-wins.
 *
 * Deliberately an allow-list and not "system columns minus a few": `created_by` is a user id and
 * `org_id` a tenant, personal data that a page allowed to read one column should not get for free.
 * A column that is added next year does not leak along that way.
 */
const ROW_ENVELOPE = Object.freeze(['id', 'updated_at']);

/** Een weigering die de route letterlijk mag doorgeven: status + code + tekst. */
class DatatableRuntimeError extends Error {
    constructor(status, code, message) {
        super(message);
        this.name = 'DatatableRuntimeError';
        this.status = status;
        this.code = code;
        this.safe = true;
    }
}

function refuse(status, code, message) {
    return new DatatableRuntimeError(status, code, message);
}

/**
 * A write to a Solution stage's reference table: its rows are the release's
 * (queryCompiler RowsLockedError, 409 `managed_part`). The error goes through
 * UNCHANGED, only with the `safe` flag added, so the routes that pass only
 * `safe` refusals on verbatim (the webpage bridge) answer it as a 409 with its
 * code instead of a 500.
 */
function passLockedRows(e) {
    if (e instanceof queryCompiler.RowsLockedError) e.safe = true;
    return e;
}

/**
 * The column list of this call, validated.
 *
 * Not an array → programming error (loud). An array but empty → a real, explainable refusal: the
 * binding names no column at all.
 */
function requireAllowColumns(allowColumns) {
    if (!Array.isArray(allowColumns)) {
        throw new Error('datatableRuntime: allowColumns is required — there is no "all columns" value');
    }
    const clean = allowColumns.filter(c => typeof c === 'string' && c.trim()).map(c => c.trim());
    if (!clean.length) {
        throw refuse(403, 'no_columns_bound',
            'This binding does not allow any column of that table');
    }
    return clean;
}

/**
 * Look up the table in the scopes of this principal and determine his grade.
 *
 * No grade → 404 (the existence of someone else's table cannot be probed); grade too low → 403
 * (then the caller already knows that it exists). The same 404-vs-403 rule as routes/datatables.js.
 */
async function resolveForPrincipal(datatableId, principal, { needed = 'viewer' } = {}) {
    if (typeof datatableId !== 'string' || !datatableId) {
        throw refuse(400, 'datatable_required', 'A datatable id is required');
    }
    const scopes = datatableScopesFor(principal);
    if (!scopes.length) {
        // Geen org én geen account: er is niemand om als te lezen.
        throw refuse(404, 'datatable_not_found', 'Not found');
    }

    let table = null;
    let scope = null;
    for (const s of scopes) {
        table = await datatableStore.getDatatable(datatableId, s);
        if (table) { scope = s; break; }
    }
    if (!table) throw refuse(404, 'datatable_not_found', 'Not found');

    const grants = await datatableStore.listGrants(table.id);
    const grade = gradeForPrincipal(table, grants, principal);
    if (!grade) throw refuse(404, 'datatable_not_found', 'Not found');
    if (!gradeAtLeast(grade, needed)) {
        throw refuse(403, 'datatable_forbidden', `This needs ${needed} access to the datatable`);
    }

    const meta = await datatableStore.getTableMeta(scope, table.id);
    if (!meta) throw refuse(409, 'datatable_no_columns', 'This datatable has no columns yet');

    return {
        table,
        scope,
        scopeKey: datatableDbStore.scopeKey(scope),
        grade,
        principal,
        // De descriptor + het toegangsblok dat de compiler leest. Altijd samen:
        // compileAccessFilter zonder `access` zou op de default terugvallen.
        meta: { ...meta, access: synthesizeAccess(table) },
    };
}

/** Does this table mirror an external source? (core/dataEngine/sources) */
function isMirror(resolved) {
    return require('./sources').isSourceMirror(resolved?.table);
}

/** De write-through van de bron-soort van deze tabel. */
function mirrorWrites(resolved) {
    return require('./sources').writeThrough(resolved.table);
}

function mirrorCtx(resolved) {
    return mirrorWrites(resolved).contextOf({
        table: resolved.table, scope: resolved.scope, scopeKey: resolved.scopeKey,
        tableMeta: resolved.meta, grade: resolved.grade, viewerId: resolved.principal?.userId || null,
    });
}

/** De kolomsleutels die de tabel zelf declareert. */
function declaredKeys(resolved) {
    const fields = Array.isArray(resolved?.meta?.fields) ? resolved.meta.fields : [];
    return fields.map(f => f && f.key).filter(k => typeof k === 'string' && k);
}

/**
 * The intersection of "what the binding allows" and "what the table still has". A column that the
 * author has meanwhile thrown away disappears this way, without the call breaking.
 */
function effectiveColumns(resolved, allowColumns) {
    const declared = new Set(declaredKeys(resolved));
    return allowColumns.filter(c => declared.has(c));
}

/**
 * Trim one row to the envelope plus the allowed columns.
 *
 * Build it from an allow-list, never remove keys from the row: a column that is added to the table
 * next year must then not end up in the answer by itself.
 */
function projectRow(row, columns) {
    if (!row || typeof row !== 'object') return null;
    const out = {};
    for (const k of ROW_ENVELOPE) if (k in row) out[k] = row[k];
    for (const k of columns) if (k in row) out[k] = row[k];
    return out;
}

/** De sorteervelden van een descriptor, in beide vormen die de compiler kent. */
function sortFields(sort) {
    if (Array.isArray(sort)) return sort.map(s => s && s.field);
    if (sort && typeof sort === 'object') return [sort.field];
    return [];
}

/** Every field that is filtered or sorted on must be bound. */
function assertFieldsBound(fields, columns) {
    const allowed = new Set(columns);
    for (const f of fields) {
        if (typeof f !== 'string' || !f) continue;
        if (!allowed.has(f)) {
            throw refuse(400, 'column_not_bound',
                `This page may not use the column "${f}" of that table`);
        }
    }
}

/**
 * One page of rows, keyset-paginated, projected onto the bound columns.
 *
 * The projection happens AFTER the query: the compiler knows no SELECT list (`SELECT *`), so the
 * database returns the whole row and this function is the place where it is decided what leaves
 * the server. That is no excuse to skip it; it is precisely why it is here and not in a route.
 */
async function readRows(resolved, { allowColumns, filters, match, sort, limit, cursor } = {}) {
    // A mirror of an external source is refreshed in the background as soon as someone looks at it
    // and the copy is older than its schema (core/dataEngine/sources). Never affects this read.
    if (isMirror(resolved)) {
        try {
            require('./sources').kickStale(resolved.table, { reason: 'view' });
        } catch (err) { bestEffort('core/dataEngine/datatableRuntime:readRows', err); /* never a reason to fail a read */ }
    }
    const columns = effectiveColumns(resolved, requireAllowColumns(allowColumns));
    if (!columns.length) {
        // The binding names only columns that do not (or no longer) exist.
        throw refuse(403, 'no_columns_bound', 'This binding does not allow any column of that table');
    }
    const filterList = Array.isArray(filters) ? filters : [];
    assertFieldsBound(filterList.map(f => f && f.field), columns);
    // `sort` may be an object OR a list: resolvePrimarySort accepts both and takes the first
    // entry of a list. Checking only `sort.field` let `sort: [{field:'geheim'}]` slip past
    // unseen, and that is precisely the oracle this check must close.
    assertFieldsBound(sortFields(sort), columns);

    await require('../../stores/lib/sheetCrypto').assertQuery(resolved, [...filterList.map(f => f?.field), ...sortFields(sort)]);

    const filter = accessFilter.compileAccessFilter(
        resolved.meta, resolved.grade, { id: resolved.principal?.userId || null }, 'read', PG);
    const compiled = queryCompiler.compileRecordList(resolved.meta, {
        filters: filterList,
        match: match || 'all',
        sort: sort || null,
        limit, maxLimit: ROWS_PAGE_MAX,
        cursor: cursor || null,
        dialect: 'pg',
    }, filter);

    const out = await datatableDbStore.query(
        resolved.scopeKey, resolved.scopeKey, compiled.sql, compiled.params);
    // NOTE when reading `nextCursor` below: it encodes the value of the primary sort field of the
    // last row, and with the default sorting that is `created_at`, a system column that is NOT in
    // the projection. The cursor is base64, not encrypted, so a page can read that date. Accepted
    // because the reader has viewer grade on the whole table anyway; whoever finds that too loose
    // must sign the cursor or set the default sort on a bound column. Do not quietly leave the
    // cursor out, because then page 2 becomes unreachable.
    const sheetCrypto = require('../../stores/lib/sheetCrypto');
    const all = sheetCrypto.isSheet(resolved) ? await sheetCrypto.openRows(resolved.table.id, out?.rows || []) : (out?.rows || []);
    // compileRecordList vraagt bewust limit+1 op als cursorsonde; die extra rij
    // hoort er nooit uit te komen.
    const page = all.slice(0, compiled.limit);
    const hasMore = all.length > compiled.limit;
    const last = page[page.length - 1];
    return {
        rows: page.map(r => projectRow(r, columns)),
        hasMore,
        count: page.length,
        nextCursor: (hasMore && last)
            ? queryCompiler.encodeCursor(last[compiled.primaryField], last.id)
            : null,
        columns,
    };
}

/**
 * Group and count, and with that: "which values occur in this column".
 *
 * Until now there was no way to ask that on behalf of a principal without reading the whole table.
 * `compileAggregate` can already do it (GROUP BY without aggregates gives exactly the distinct values);
 * what was missing was this place, with the SAME bounding as `readRows`: the column list also binds
 * what you may group and count. Otherwise "group by the column I may not read" is the same oracle
 * that `assertFieldsBound` keeps closed for filtering and sorting.
 *
 * The access filter goes into the WHERE, before the GROUP BY (invariant of the compiler): a row that
 * this person may not see does not count either.
 */
async function aggregateRows(resolved, { allowColumns, groupBy, aggregates, filters, match, sort, limit } = {}) {
    const columns = effectiveColumns(resolved, requireAllowColumns(allowColumns));
    if (!columns.length) {
        throw refuse(403, 'no_columns_bound', 'This binding does not allow any column of that table');
    }
    const groups = Array.isArray(groupBy) ? groupBy : [];
    const aggs = Array.isArray(aggregates) ? aggregates : [];
    const filterList = Array.isArray(filters) ? filters : [];
    assertFieldsBound(groups.map(g => g && g.field), columns);
    // `count(*)` has no field; only a real column name is checked.
    assertFieldsBound(aggs.map(a => (a && a.field !== '*' ? a && a.field : null)), columns);
    assertFieldsBound(filterList.map(f => f && f.field), columns);
    assertFieldsBound(sortFields(sort), columns);

    await require('../../stores/lib/sheetCrypto').assertQuery(resolved, [...groups.map(g => g?.field), ...aggs.map(a => a?.field), ...filterList.map(f => f?.field), ...sortFields(sort)]);

    const filter = accessFilter.compileAccessFilter(
        resolved.meta, resolved.grade, { id: resolved.principal?.userId || null }, 'read', PG);
    const compiled = queryCompiler.compileAggregate(resolved.meta, {
        filters: filterList,
        match: match || 'all',
        groupBy: groups,
        aggregates: aggs,
        sort: sort || null,
        limit,
        dialect: 'pg',
    }, filter);
    const out = await datatableDbStore.query(
        resolved.scopeKey, resolved.scopeKey, compiled.sql, compiled.params);
    return { rows: out?.rows || [] };
}

/**
 * The values of a write action, checked against the binding.
 *
 * A non-bound column is REFUSED, not quietly left out: a page that thinks it has saved a field while
 * that is not so is worse than a page that gets an error message.
 */
function assertValuesBound(values, columns) {
    if (!values || typeof values !== 'object' || Array.isArray(values)) {
        throw refuse(400, 'no_values', 'Say which columns to write');
    }
    const keys = Object.keys(values);
    if (!keys.length) throw refuse(400, 'no_values', 'Say which columns to write');
    assertFieldsBound(keys, columns);
    return values;
}

/** Eén rij toevoegen. Vereist graad `editor` én create-recht op de descriptor. */
async function insertRow(resolved, { allowColumns, values } = {}) {
    const columns = effectiveColumns(resolved, requireAllowColumns(allowColumns));
    const clean = await require('../../stores/lib/sheetCrypto').sealValues(resolved, assertValuesBound(values, columns));
    accessFilter.assertCanWrite(resolved.meta, resolved.grade, 'create');
    // A mirror: the row goes FIRST to Nextcloud, and the copy follows from what Nextcloud answered.
    // The same refusals (status/code/safe) as here.
    if (isMirror(resolved)) {
        const r = await mirrorWrites(resolved).insertRow(mirrorCtx(resolved), clean);
        return { id: r.id };
    }
    let compiled;
    try {
        compiled = queryCompiler.compileInsert(resolved.meta, clean, {
            createdBy: resolved.principal?.userId || null,
            // NULL on a personal table, and that is right: that row belongs to no organisation.
            // Filling in the ctx org here would make the row look shared.
            orgId: resolved.table.organizationId,
            dialect: 'pg',
        });
    } catch (e) { throw passLockedRows(e); }
    const { sql, params, id } = compiled;
    await datatableDbStore.exec(resolved.scopeKey, resolved.scopeKey, sql, params);
    await datatableStore.bumpAfterWrite(resolved.table.id, resolved.scope, 1);
    return { id };
}

/**
 * Eén rij wijzigen, met optimistisch slot.
 *
 * `expectedUpdatedAt` is verplicht, net als in routes/datatables.js: elke lezing
 * levert `updated_at` mee, dus een schrijver kán hem hebben, en zonder hem is
 * elke wijziging last-write-wins tussen twee bezoekers van dezelfde pagina.
 */
async function updateRow(resolved, { allowColumns, rowId, values, expectedUpdatedAt } = {}) {
    const columns = effectiveColumns(resolved, requireAllowColumns(allowColumns));
    if (typeof rowId !== 'string' || !rowId) {
        throw refuse(400, 'row_required', 'A row id is required');
    }
    if (typeof expectedUpdatedAt !== 'string' || !expectedUpdatedAt) {
        throw refuse(400, 'expected_updated_at_required',
            'Send the updated_at you read, so a colleague\'s edit is not silently overwritten');
    }
    const clean = await require('../../stores/lib/sheetCrypto').sealValues(resolved, assertValuesBound(values, columns), rowId);
    accessFilter.assertCanWrite(resolved.meta, resolved.grade, 'update');

    if (isMirror(resolved)) {
        const r = await mirrorWrites(resolved).updateRow(mirrorCtx(resolved), rowId, clean, { expectedUpdatedAt });
        if (!r.changes) {
            if (!r.row) throw refuse(404, 'row_not_found', 'Not found');
            const conflict = refuse(409, 'row_conflict', 'Someone else changed this row while you had it open');
            conflict.row = projectRow(r.row, columns);
            throw conflict;
        }
        return { row: projectRow(r.row, columns) };
    }

    const filter = accessFilter.compileAccessFilter(
        resolved.meta, resolved.grade, { id: resolved.principal?.userId || null }, 'update', PG);
    let upd;
    try {
        upd = queryCompiler.compileUpdate(resolved.meta, rowId, clean, filter,
            { expectedUpdatedAt, dialect: 'pg' });
    } catch (e) { throw passLockedRows(e); }
    const out = await datatableDbStore.exec(resolved.scopeKey, resolved.scopeKey, upd.sql, upd.params);

    // Always read back: on success the caller needs the new `updated_at` for ITS NEXT change,
    // and on failure the row itself is the difference between "someone else was there before you"
    // and "it no longer exists for you".
    const probe = queryCompiler.compileGetById(resolved.meta, rowId, filter, PG);
    const found = await datatableDbStore.query(resolved.scopeKey, resolved.scopeKey, probe.sql, probe.params);
    const rawRow = (found?.rows || [])[0] || null;
    const sheetCrypto = require('../../stores/lib/sheetCrypto');
    const row = sheetCrypto.isSheet(resolved) ? await sheetCrypto.openRow(resolved.table.id, rawRow) : rawRow;

    if (!out?.changes) {
        if (!row) throw refuse(404, 'row_not_found', 'Not found');
        const conflict = refuse(409, 'row_conflict', 'Someone else changed this row while you had it open');
        conflict.row = projectRow(row, columns);
        throw conflict;
    }
    await datatableStore.bumpAfterWrite(resolved.table.id, resolved.scope, 0);
    return { row: projectRow(row, columns) };
}

module.exports = {
    DatatableRuntimeError,
    ROW_ENVELOPE,
    ROWS_PAGE_MAX,
    resolveForPrincipal,
    readRows,
    aggregateRows,
    insertRow: (resolved, args) => require('../../stores/lib/sheetCrypto').withWrite(resolved, () => insertRow(resolved, args)),
    updateRow: (resolved, args) => require('../../stores/lib/sheetCrypto').withWrite(resolved, () => updateRow(resolved, args)),
    projectRow,
    // test-only
    _effectiveColumns: effectiveColumns,
};
