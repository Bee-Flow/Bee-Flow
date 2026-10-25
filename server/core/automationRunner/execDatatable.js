// @typecheck
/**
 * The `datatable` step — the only step whose effect outlives the run.
 *
 * Reads and writes rows of an organisation-scoped table through the SAME engine
 * App Studio uses: core/dataEngine/queryCompiler generates every statement from
 * a validated table descriptor plus a closed-vocabulary request, and
 * core/dataEngine/accessFilter produces the predicate that is ANDed into all of
 * them. There is no path from a step field to a SQL string.
 *
 * ── SIX THINGS THIS REFUSES TO DO ───────────────────────────────────
 *
 * 1. GUESS A TENANT. A table is looked for in the run's ORGANISATION
 *    (`ctx.orgId`) and then in the owner's PERSONAL scope — the two scopes the
 *    author could have created it in, and nowhere else. It is never looked up
 *    globally and then checked, and never falls back to some other org: a
 *    shared, writable resource keyed on a guess is how rows end up in the wrong
 *    tenant. With neither scope available the step fails loudly with
 *    `datatable_no_org`.
 *
 *    And when the run's IDENTITY could not be read at all
 *    (execution.js records `ctx.identityError`), an org-scoped table fails with
 *    `datatable_identity_unavailable` rather than with `datatable_forbidden`.
 *    An unresolved orgRole degrades to "not an admin" and an unresolved group
 *    list to "in no group", so the old behaviour reported a lookup outage as an
 *    authorisation refusal on an automation that worked yesterday. A personal table
 *    is unaffected: its rule is "you are the account", which needs none of them.
 *
 * 2. DEGRADE AN UNRESOLVED FILTER TO "ALL ROWS". ANY operation whose condition
 *    binds to nothing is SKIPPED, not widened.
 *    appStudio/stepDataSource.js:46-55 documents the incident where dropping an
 *    unresolved filter listed every attachment in an app; here the same mistake
 *    would delete every row in a table. The skip covers reads too, and it has
 *    to: "find rows where email = {{steps.form.output.email}}" with an empty
 *    upstream becomes "list the first 50 rows", and those rows flow into the
 *    next AI step, notification or http_request as if they were the match. A
 *    read does not destroy data — it discloses somebody else's.
 *
 * 3. TRUST A GRADE FROM A PREVIOUS RUN. The grade is resolved on every run, for
 *    the same reason execAi re-checks the tool catalogue: a grant revoked
 *    yesterday must stop working today.
 *
 * 4. WRITE A SECRET INTO A ROW. Datatable rows deliberately bypass
 *    redactForPersistence — they are the user's own structured data, not a log —
 *    so the one path that would turn a credential into a permanent row is
 *    closed explicitly.
 *
 * 5. OVERWRITE A COLUMN WITH A BINDING THAT RESOLVED TO NOTHING. On an
 *    `update_rows` an unresolved value is DROPPED, not written: a ref that
 *    found nothing resolves to `undefined` → coerceValue → NULL and a template
 *    that found nothing resolves to '', so across every row the step matched it
 *    blanks columns nobody asked to change. The editor already promises this at
 *    save time (formState.buildPatch: "an empty binding means leave this column
 *    alone, not write blank") and kept the promise only for values that were
 *    empty in the builder.
 *
 * 6. REPORT A PARTIAL DESTRUCTIVE WRITE AS A SUCCESS. `update_rows` and
 *    `delete_rows` select DATATABLE_MAX_LIMIT + 1 targets, so "there were more"
 *    is a fact rather than an assumption. An update says so (`truncated`); a
 *    DELETE refuses outright with `datatable_too_many_rows`, because nobody
 *    re-runs a green delete and the rows it did not reach then sit there
 *    believed gone.
 *
 * ── DRY RUN ─────────────────────────────────────────────────────────
 * `find_rows` and `count_rows` run for real: they are access-filtered, so they
 * cannot show the author anything they could not already see, and a synthesised
 * answer would hide the very output they are inspecting. Every WRITE is
 * synthesised — a preview must not leave rows behind.
 *
 * The writes (refusals 4 to 6) are in ./datatableWrites.js.
 */

'use strict';

const { resolveValue, resolveInputs } = require('../automationModel/bind');
const { hasPlaceholder } = require('../automationModel/refPaths');
const {
    DATATABLE_WRITE_OPS, DATATABLE_MAX_LIMIT, PENDING_DATATABLE_RE,
} = require('../automationModel/constants');
// Literals only — no store, no pool — so this one may be required eagerly.
const { SYSTEM_COLUMNS } = require('../dataEngine/dataModel/vocabulary');
// The tenant + grade resolution, shared with the http_request step's cacheInto.
const { resolveDatatableForStep } = require('./datatableResolve');
const {
    PG, MIRROR_WRITE_MAX_PER_STEP, NC_WRITE_MAX_PER_STEP, fail, skipped, emptyOutput,
} = require('./datatableStepShared');
// Every write op (values, permission, preview, add/save/update/delete).
const { runDatatableWrite } = require('./datatableWrites');

const DEFAULT_LIMIT = 50;

/**
 * Resolve one condition's value against the run state. Returns `undefined` when
 * the binding resolved to nothing, which the caller treats as "unresolved" —
 * never as "match everything".
 */
function resolveCondition(w, runState) {
    const value = w.value === undefined ? undefined : resolveValue(w.value, runState, { allowSecrets: false });
    return { field: w.field, op: w.op, value };
}

/** Ops that need no value: `isNull` / `isNotNull` are complete on their own. */
const VALUELESS_OPS = new Set(['isNull', 'isNotNull']);

/**
 * The keyset cursor a `find_rows` step was given — a binding like every other
 * field, so `{{steps.page1.output.nextCursor}}` is how a loop walks a table
 * bigger than one page. Anything that is not a non-empty string is page 1.
 *
 * A bare STRING with a placeholder is that template (the AI builder used to
 * store the cursor that way, and the validator and portability read it so);
 * resolveValue would take it for a literal and hand the query the braces.
 */
function readCursor(binding, runState) {
    if (binding === undefined || binding === null || binding === '') return null;
    const asBinding = typeof binding === 'string' && hasPlaceholder(binding) ? { kind: 'template', value: binding } : binding;
    const v = resolveValue(asBinding, runState, { allowSecrets: false });
    return typeof v === 'string' && v ? v : null;
}

/**
 * A table the builder only PROPOSED ("pending:<n>", not created until the
 * user applies the proposal). Before any lookup: resolveDatatableForStep
 * would call it unknown. A preview simulates it (reads return the empty
 * shape, which is true of a new table; a write returns what it would
 * write); a live run must never get here, and fails closed.
 * Returns the step result, or null for a real table.
 */
function pendingTableResult(step, runState, mode, op) {
    // nosemgrep: ajinabraham.njsscan.dos.regex_dos.regex_dos -- PENDING_DATATABLE_RE is anchored and bounded (pending:1-999)
    if (typeof step.datatableId !== 'string' || !PENDING_DATATABLE_RE.test(step.datatableId)) return null;
    if (mode !== 'dry_run') {
        throw fail('This step points at a table that was proposed but never created. Apply the proposal that creates it, or pick a table.', 'datatable_pending');
    }
    const preview = (op === 'add_row' || op === 'save_row')
        ? { row: resolveInputs(step.values || {}, runState, { allowSecrets: false, listAs: 'json' }), id: null, created: true, updated: 0 }
        : emptyOutput(op);
    return { output: { ...preview, _dryRunSynthesised: true, _pendingTable: step.datatableId } };
}

/**
 * ── 3. conditions — resolved, never widened ─────────────────────────
 * Returns the resolved filters, or the amber skip that stops the step: an
 * unknown column, or a condition whose binding came out empty.
 */
function resolveConditions(step, runState, { op, isWrite, table, filterable }) {
    const rawWhere = Array.isArray(step.where) ? step.where : [];
    const filters = [];
    const unresolved = [];
    const unknownColumns = [];
    for (const w of rawWhere) {
        if (!w || !w.field) continue;
        if (!filterable.has(w.field)) { unknownColumns.push(w.field); continue; }
        const c = resolveCondition(w, runState);
        if (!VALUELESS_OPS.has(c.op) && (c.value === undefined || c.value === null || c.value === '')) {
            unresolved.push(w.field);
            continue;
        }
        filters.push(c);
    }
    if (unknownColumns.length) {
        // The column was removed or renamed on the table after this step was
        // written. Skipping loudly mirrors skippedArrayRef: the run continues,
        // the row shows amber, and the message names the column.
        return {
            skip: skipped('datatable_column_unknown',
                `the column${unknownColumns.length > 1 ? 's' : ''} ${unknownColumns.map(c => `"${c}"`).join(', ')} ${unknownColumns.length > 1 ? 'are' : 'is'} no longer on "${table.name}"`,
                emptyOutput(op)),
        };
    }
    if (unresolved.length) {
        // THE important refusal, and it is not only about writes. Widening an
        // update or delete changes the whole table; widening a READ hands the
        // next step rows nobody asked for and calls them the match.
        const cols = unresolved.map(c => `"${c}"`).join(', ');
        return {
            skip: skipped('datatable_filter_unresolved',
                isWrite
                    ? `nothing to match on — ${cols} came out empty, and running this without a condition would change every row`
                    : `nothing to match on — ${cols} came out empty, and running this without a condition would return rows that were never asked for`,
                emptyOutput(op)),
        };
    }
    return { filters };
}

/**
 * The access predicates. 'create' deliberately gets NO filter: a create has no
 * rows to filter and compileAccessFilter refuses to invent a predicate for
 * one. save_row needs TWO — a READ filter for the probe that looks the
 * existing row up, and an UPDATE filter for the statement that rewrites it.
 * Compiling one filter from 'create' for both is what made every upsert an
 * append.
 */
function compileAccess(op, { tableMeta, grade, ctx }, accessFilter) {
    const viewer = { id: ctx.userId };
    const isRead = op === 'find_rows' || op === 'count_rows';
    const accessAction = isRead ? 'read'
        : op === 'delete_rows' ? 'delete'
            : op === 'add_row' ? 'create' : 'update';
    const readFilter = (isRead || op === 'save_row')
        ? accessFilter.compileAccessFilter(tableMeta, grade, viewer, 'read', PG)
        : null;
    const writeFilter = (accessAction === 'update' || accessAction === 'delete')
        ? accessFilter.compileAccessFilter(tableMeta, grade, viewer, accessAction, PG)
        : null;
    return { accessAction, readFilter, writeFilter };
}

/** ── 4. reads: find_rows ─────────────────────────────────────────── */
async function findRows(t, runState, { datatableDbStore, queryCompiler }) {
    const { step } = t;
    const compiled = queryCompiler.compileRecordList(t.tableMeta, {
        filters: t.filters,
        match: t.match,
        sort: Array.isArray(step.sort) ? step.sort : [],
        limit: step.limit === undefined || step.limit === null ? DEFAULT_LIMIT : step.limit,
        maxLimit: DATATABLE_MAX_LIMIT,
        // The page a previous run (or a previous loop iteration) stopped
        // at. Without it a table larger than DATATABLE_MAX_LIMIT had no
        // second page at all: the step took no cursor in and produced none
        // out. A cursor that resolves to nothing is page 1 — decodeCursor
        // already treats a malformed one that way, and a read that widened
        // to "everything" here would only repeat rows, never leak them.
        cursor: readCursor(step.cursor, runState),
        dialect: 'pg',
    }, t.readFilter);
    const out = await datatableDbStore.query(t.scopeKey, t.scopeKey, compiled.sql, compiled.params);
    // compileRecordList asks for limit+1 as a cursor probe. Every caller
    // must slice; stepDataSource.js records the bug where the extra row
    // leaked into an AI prompt.
    const all = out.rows || [];
    const rows = all.slice(0, compiled.limit);
    const hasMore = all.length > compiled.limit;
    const last = rows[rows.length - 1];
    return {
        output: {
            rows,
            // `returned` is how many rows THIS PAGE holds. It was called
            // `count`, which reads as "how many rows match" — and it never
            // was: it is rows.length clamped by the page size, so a
            // condition on `count > 100` after a default page of 50 could
            // never fire. `count` survives as an alias for one release so
            // existing automations keep working; count_rows answers the
            // question the name promised.
            returned: rows.length,
            count: rows.length,
            found: rows.length > 0,
            hasMore,
            nextCursor: (hasMore && last)
                ? queryCompiler.encodeCursor(last[compiled.primaryField], last.id)
                : null,
        },
    };
}

/**
 * count_rows: COUNT(*) through compileAggregate, which ANDs the same access
 * predicate into the WHERE that feeds the aggregate — so a count can never
 * report rows the automation may not read.
 */
async function countRows(t, { datatableDbStore, queryCompiler }) {
    const { sql, params } = queryCompiler.compileAggregate(t.tableMeta, {
        filters: t.filters, match: t.match, aggregates: [{ fn: 'count', field: '*', as: 'total' }], dialect: 'pg',
    }, t.readFilter);
    const out = await datatableDbStore.query(t.scopeKey, t.scopeKey, sql, params);
    const count = Number((out.rows || [])[0]?.total) || 0;
    return { output: { count, found: count > 0 } };
}

async function execDatatable(step, ctx, runState, mode) {
    const op = step.op || 'find_rows';
    const isWrite = DATATABLE_WRITE_OPS.has(op);
    const pending = pendingTableResult(step, runState, mode, op);
    if (pending) return pending;

    // Required lazily: the runner must stay loadable in suites that stub the DB,
    // and these pull in the pg pool.
    const s = {
        datatableDbStore: require('../../stores/datatableDbStore'),
        queryCompiler: require('../dataEngine/queryCompiler'),
    };
    const accessFilter = require('../dataEngine/accessFilter');

    // ── 1+2. the tenant and the grade ───────────────────────────────────
    // Both live in datatableResolve, shared with the http_request step's
    // "remember answers in a table" tick. Two copies of a tenancy decision and
    // an authorisation decision is two things that can drift, and the copy that
    // drifts is the one nobody is looking at.
    const resolved = await resolveDatatableForStep(step.datatableId, ctx, {
        needed: isWrite ? 'editor' : 'viewer',
    });
    const { table, declared } = resolved;
    // A FILTER may also address the system columns — queryCompiler.resolveColumn
    // allows them. Checking `where` against the declared list alone reported
    // `created_at` as "no longer on this table" while a SORT on the same name
    // compiled fine.
    const filterable = new Set([...declared, ...SYSTEM_COLUMNS]);
    const conditions = resolveConditions(step, runState, { op, isWrite, table, filterable });
    if (conditions.skip) return conditions.skip;

    const t = {
        ...resolved, step, ctx, runState, op, mode,
        filters: conditions.filters,
        // How the conditions join. ONE top-level combinator; the access predicate
        // is ANDed OUTSIDE the OR group by buildWhere, because `access OR status =
        // 'new'` would hand every row of the table to anyone who asked.
        match: step.match === 'any' ? 'any' : 'all',
        ...compileAccess(op, { ...resolved, ctx }, accessFilter),
    };
    if (op === 'find_rows') return findRows(t, runState, s);
    if (op === 'count_rows') return countRows(t, s);
    // ── 5. writes ───────────────────────────────────────────────────────
    return runDatatableWrite(t);
}

module.exports = { execDatatable, MIRROR_WRITE_MAX_PER_STEP, NC_WRITE_MAX_PER_STEP, _test: { readCursor } };

/** @typedef {import('../automationModel/bind').BindRunState} BindRunState */

/** @typedef {import('./datatableStepShared').DatatableStepContext} DatatableStepContext */

/** @typedef {{ field?: string, op?: string, value?: unknown }} DatatableCondition */

/**
 * The config fields the datatable step reads.
 * @typedef {{ id?: string, op?: string, datatableId?: string, values?: Record<string, unknown>, where?: DatatableCondition[],
 *   sort?: unknown[], limit?: number, cursor?: unknown, match?: string, matchColumn?: string, [key: string]: unknown }} DatatableStep
 */

/** @typedef {Parameters<typeof resolveDatatableForStep>[1] & DatatableStepContext['ctx']} DatatableCtx */

/** @typedef {{ datatableDbStore: typeof import('../../stores/datatableDbStore'), queryCompiler: typeof import('../dataEngine/queryCompiler') }} ReadStores */
