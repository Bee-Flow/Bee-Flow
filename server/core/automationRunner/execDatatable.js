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
 */

'use strict';

const { resolveValue, resolveInputs } = require('../../automation/bind');
const { hasPlaceholder } = require('../../automation/validate/refPaths');
const {
    DATATABLE_WRITE_OPS, DATATABLE_MAX_LIMIT, PENDING_DATATABLE_RE,
} = require('../../automation/validate/constants');
// Literals only — no store, no pool — so this one may be required eagerly.
const { SYSTEM_COLUMNS } = require('../dataEngine/dataModel/vocabulary');
// The storage envelope, shared with routes/datatables.js so the HTTP surface
// and the runner cannot disagree about whether a tenant is full. Literals plus
// one helper that lazily requires the store, so this stays loadable in the
// suites that stub the database.
const { assertDatatableQuota } = require('../dataEngine/datatableLimits');
// The tenant + grade resolution, shared with the http_request step's cacheInto.
const { resolveDatatableForStep } = require('./datatableResolve');

// Rows live in a Postgres schema. The App Studio engine flag may say 'sqlite'
// on the same server, so every compile on this path states its dialect.
const PG = { dialect: 'pg' };
const DEFAULT_LIMIT = 50;
// Rows one step may write into a SOURCE MIRROR (core/dataEngine/sources): a
// source without a batch call takes them one at a time, so this bounds the
// step's duration where DATATABLE_MAX_LIMIT bounds a local transaction's
// size. The Nextcloud-era name is kept as an alias for whoever imports it.
const MIRROR_WRITE_MAX_PER_STEP = 200;
const NC_WRITE_MAX_PER_STEP = MIRROR_WRITE_MAX_PER_STEP;
// Statements one transaction may carry — pgAppEngine.batch refuses more.
// update_rows/delete_rows used to issue ONE exec per id: 801 round trips and
// 801 transactions for 800 rows, with bumpAfterWrite unreachable if the process
// died half way through.
const WRITE_CHUNK = 500;

function sources() {
    return require('../dataEngine/sources');
}

/** Does this datatable mirror an external source? (core/dataEngine/sources) */
function isMirror(table) {
    return sources().isSourceMirror(table);
}

/** The write-through of the table's own kind. */
function mirrorWrites(table) {
    return sources().writeThrough(table);
}

function mirrorCtx({ table, scope, scopeKey, tableMeta, grade, ctx }) {
    return mirrorWrites(table).contextOf({ table, scope, scopeKey, tableMeta, grade, viewerId: ctx.userId || null });
}

function fail(message, errorClass) {
    const e = new Error(message);
    e.errorClass = errorClass;
    return e;
}

/** A step-level skip, in the shape the runner already renders amber. */
function skipped(reason, message, output) {
    return { output: { ...output, skipped: message }, skippedReason: reason };
}

/**
 * The zero-effect output for an op. A skip has to hand downstream the SAME
 * shape a real run would, or a `steps.x.output.rows` binding on the next step
 * resolves to nothing and the failure moves one node along.
 */
function emptyOutput(op) {
    if (op === 'update_rows') return { updated: 0, truncated: false };
    if (op === 'delete_rows') return { deleted: 0, truncated: false };
    if (op === 'add_row' || op === 'save_row') return { row: null, id: null, created: false, updated: 0 };
    if (op === 'count_rows') return { count: 0, found: false };
    // `count` is the DEPRECATED alias of `returned` — see the find_rows branch.
    return { rows: [], returned: 0, count: 0, found: false, hasMore: false, nextCursor: null };
}

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

async function execDatatable(step, ctx, runState, mode) {
    const op = step.op || 'find_rows';
    const isWrite = DATATABLE_WRITE_OPS.has(op);

    // A table the builder only PROPOSED ("pending:<n>", not created until the
    // user applies the proposal). Before any lookup: resolveDatatableForStep
    // would call it unknown. A preview simulates it (reads return the empty
    // shape, which is true of a new table; a write returns what it would
    // write); a live run must never get here, and fails closed.
    // nosemgrep: ajinabraham.njsscan.dos.regex_dos.regex_dos -- PENDING_DATATABLE_RE is anchored and bounded (pending:1-999)
    if (typeof step.datatableId === 'string' && PENDING_DATATABLE_RE.test(step.datatableId)) {
        if (mode !== 'dry_run') {
            throw fail('This step points at a table that was proposed but never created. Apply the proposal that creates it, or pick a table.', 'datatable_pending');
        }
        const preview = (op === 'add_row' || op === 'save_row')
            ? { row: resolveInputs(step.values || {}, runState, { allowSecrets: false, listAs: 'json' }), id: null, created: true, updated: 0 }
            : emptyOutput(op);
        return { output: { ...preview, _dryRunSynthesised: true, _pendingTable: step.datatableId } };
    }

    // Required lazily: the runner must stay loadable in suites that stub the DB,
    // and these pull in the pg pool.
    const datatableStore = require('../../stores/datatableStore');
    const datatableDbStore = require('../../stores/datatableDbStore');
    const queryCompiler = require('../dataEngine/queryCompiler');
    const accessFilter = require('../dataEngine/accessFilter');

    // ── 1+2. the tenant and the grade ───────────────────────────────────
    // Both live in datatableResolve, shared with the http_request step's
    // "remember answers in a table" tick. Two copies of a tenancy decision and
    // an authorisation decision is two things that can drift, and the copy that
    // drifts is the one nobody is looking at.
    const {
        table, scope, scopeKey, orgId, grade, tableMeta, declared,
    } = await resolveDatatableForStep(step.datatableId, ctx, {
        needed: isWrite ? 'editor' : 'viewer',
    });
    // A FILTER may also address the system columns — queryCompiler.resolveColumn
    // allows them. Checking `where` against the declared list alone reported
    // `created_at` as "no longer on this table" while a SORT on the same name
    // compiled fine.
    const filterable = new Set([...declared, ...SYSTEM_COLUMNS]);

    // ── 3. conditions — resolved, never widened ─────────────────────────
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
        return skipped('datatable_column_unknown',
            `the column${unknownColumns.length > 1 ? 's' : ''} ${unknownColumns.map(c => `"${c}"`).join(', ')} ${unknownColumns.length > 1 ? 'are' : 'is'} no longer on "${table.name}"`,
            emptyOutput(op));
    }
    if (unresolved.length) {
        // THE important refusal, and it is not only about writes. Widening an
        // update or delete changes the whole table; widening a READ hands the
        // next step rows nobody asked for and calls them the match.
        const cols = unresolved.map(c => `"${c}"`).join(', ');
        return skipped('datatable_filter_unresolved',
            isWrite
                ? `nothing to match on — ${cols} came out empty, and running this without a condition would change every row`
                : `nothing to match on — ${cols} came out empty, and running this without a condition would return rows that were never asked for`,
            emptyOutput(op));
    }

    // 'create' deliberately gets NO filter: a create has no rows to filter and
    // compileAccessFilter refuses to invent a predicate for one. save_row needs
    // TWO — a READ filter for the probe that looks the existing row up, and an
    // UPDATE filter for the statement that rewrites it. Compiling one filter
    // from 'create' for both is what made every upsert an append.
    const viewer = { id: ctx.userId };
    const isRead = op === 'find_rows' || op === 'count_rows';
    const accessAction = isRead ? 'read'
        : op === 'delete_rows' ? 'delete'
            : op === 'add_row' ? 'create' : 'update';
    const readFilter = (isRead || op === 'save_row')
        ? accessFilter.compileAccessFilter(tableMeta, grade, viewer, 'read', PG)
        : null;
    // How the conditions join. ONE top-level combinator; the access predicate
    // is ANDed OUTSIDE the OR group by buildWhere, because `access OR status =
    // 'new'` would hand every row of the table to anyone who asked.
    const match = step.match === 'any' ? 'any' : 'all';
    const writeFilter = (accessAction === 'update' || accessAction === 'delete')
        ? accessFilter.compileAccessFilter(tableMeta, grade, viewer, accessAction, PG)
        : null;

    // ── 4. reads ────────────────────────────────────────────────────────
    if (op === 'find_rows') {
        const compiled = queryCompiler.compileRecordList(tableMeta, {
            filters,
            match,
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
        }, readFilter);
        const out = await datatableDbStore.query(scopeKey, scopeKey, compiled.sql, compiled.params);
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

    if (op === 'count_rows') {
        // COUNT(*) through compileAggregate, which ANDs the same access
        // predicate into the WHERE that feeds the aggregate — so a count can
        // never report rows the automation may not read.
        const { sql, params } = queryCompiler.compileAggregate(tableMeta, {
            filters, match, aggregates: [{ fn: 'count', field: '*', as: 'total' }], dialect: 'pg',
        }, readFilter);
        const out = await datatableDbStore.query(scopeKey, scopeKey, sql, params);
        const count = Number((out.rows || [])[0]?.total) || 0;
        return { output: { count, found: count > 0 } };
    }

    // ── 5. writes ───────────────────────────────────────────────────────
    // A cell is data: a list in a `{{…}}` is stored as JSON, as it always was.
    const resolvedValues = resolveInputs(step.values || {}, runState, { allowSecrets: false, listAs: 'json' });

    // A credential must never become a permanent row. Rows deliberately skip
    // redactForPersistence (they are the user's own data, not a log), so this
    // is the one place that path is closed.
    const secretValues = typeof ctx.secretValues === 'function' ? ctx.secretValues() : null;
    if (Array.isArray(secretValues) && secretValues.length) {
        for (const v of Object.values(resolvedValues)) {
            if (typeof v === 'string' && secretValues.some(sv => sv && v.includes(sv))) {
                throw fail(
                    'That would write a credential into a datatable row. Use the secret where it is needed instead of storing it.',
                    'datatable_secret_refused',
                );
            }
        }
    }
    for (const key of Object.keys(resolvedValues)) {
        if (!declared.has(key)) {
            return skipped('datatable_column_unknown',
                `the column "${key}" is no longer on "${table.name}"`,
                emptyOutput(op));
        }
    }
    if (op === 'save_row' && !declared.has(step.matchColumn)) {
        // A renamed match column used to reach compileRecordList and throw a
        // raw CompileError naming the compiler rather than the table. Same
        // amber skip the value columns already take.
        return skipped('datatable_column_unknown',
            `the match column ${step.matchColumn ? `"${step.matchColumn}"` : '(none chosen)'} is no longer on "${table.name}"`,
            emptyOutput(op));
    }

    // An unresolved value may never overwrite a real column: a ref that found
    // nothing resolves to `undefined` → coerceValue → NULL, a template that
    // found nothing resolves to '', and an update writes that over every row it
    // matched. Dropping the key leaves the column alone — the promise
    // formState.buildPatch already makes in the editor. An explicit
    // {kind:'literal', value:null} survives, because writing NULL IS the
    // author's choice. add_row/save_row keep empties: a new row's blank is a
    // blank, not a silent overwrite of something that was there.
    let values = resolvedValues;
    if (op === 'update_rows') {
        values = {};
        const dropped = [];
        for (const [k, v] of Object.entries(resolvedValues)) {
            if (v === undefined || v === '') { dropped.push(k); continue; }
            values[k] = v;
        }
        if (!Object.keys(values).length) {
            return skipped('datatable_values_unresolved',
                `nothing left to write — ${dropped.map(k => `"${k}"`).join(', ')} came out empty, and writing ${dropped.length > 1 ? 'those columns' : 'that column'} blank would overwrite real data`,
                emptyOutput(op));
        }
    }

    // BEFORE the preview is synthesised: an author who may not write should be
    // told while building, not on the first live run. An upsert can take either
    // branch, so it needs both permissions before either one runs.
    if (op === 'save_row') {
        accessFilter.assertCanWrite(tableMeta, grade, 'create');
        accessFilter.assertCanWrite(tableMeta, grade, 'update');
    } else {
        accessFilter.assertCanWrite(tableMeta, grade, accessAction);
    }
    // A Solution stage's reference table: its rows are the release's. The
    // compiler refuses every write on it (RowsLockedError, errorClass
    // `managed_part`, which an on_error branch matches); asked here as well so
    // a preview says so instead of synthesising a write the live run refuses.
    queryCompiler.assertRowsWritable(tableMeta);

    if (mode === 'dry_run') {
        // A preview must not leave rows behind — and it must not describe a
        // shape the live path never returns, or the author binds to a field
        // that only exists in previews.
        const preview = op === 'delete_rows' ? { deleted: 0 }
            : op === 'update_rows' ? { updated: 0 }
                : { row: values, id: null, created: true, updated: 0 };
        return { output: { ...preview, _dryRunSynthesised: true } };
    }

    if (op === 'add_row' || op === 'save_row') {
        if (op === 'save_row') {
            // Find the existing row by the author's match column first. An
            // upsert compiled as INSERT-then-retry would need a unique index
            // the author may not have declared; a lookup works either way and
            // keeps the access filter in the WHERE.
            const matchValue = values[step.matchColumn];
            if (matchValue !== undefined && matchValue !== null) {
                const probe = queryCompiler.compileRecordList(tableMeta, {
                    filters: [{ field: step.matchColumn, op: 'eq', value: matchValue }],
                    limit: 1, dialect: 'pg',
                }, readFilter);
                const found = await datatableDbStore.query(scopeKey, scopeKey, probe.sql, probe.params);
                const existing = (found.rows || [])[0];
                if (existing && isMirror(table)) {
                    const r = await mirrorWrites(table).updateRow(mirrorCtx({ table, scope, scopeKey, tableMeta, grade, ctx }), existing.id, values);
                    return {
                        output: {
                            row: r.row || { ...existing, ...values }, id: existing.id,
                            created: false, updated: r.changes,
                        },
                    };
                }
                if (existing) {
                    const upd = queryCompiler.compileUpdate(tableMeta, existing.id, values, writeFilter, { dialect: 'pg' });
                    const res = await datatableDbStore.exec(scopeKey, scopeKey, upd.sql, upd.params);
                    await datatableStore.bumpAfterWrite(table.id, scope, 0);
                    // The real row count, not a hard-coded 1: the row can be
                    // readable and still out of the UPDATE's scope, and
                    // reporting 1 for a statement that changed nothing is how a
                    // automation claims to have saved something it did not.
                    return {
                        output: {
                            row: { ...existing, ...values }, id: existing.id,
                            created: false, updated: Number(res?.changes ?? 0),
                        },
                    };
                }
            }
        }
        // The storage envelope — the SAME check routes/datatables.js runs, so
        // the two cannot disagree about whether a table is full.
        // validate/constants.js promises authors that a datatable step "fails
        // on … a quota" so an on_error branch catches something; only the HTTP
        // route ever enforced it, and only the per-table row cap, so in a
        // automation it caught nothing and the shared volume had no ceiling at all.
        await assertDatatableQuota(scope, { table, addRows: 1 });
        // A mirror: the source first, the copy from its answer. A refusal
        // carries `errorClass`, so an on_error branch matches it like any
        // other datatable failure.
        if (isMirror(table)) {
            const r = await mirrorWrites(table).insertRow(mirrorCtx({ table, scope, scopeKey, tableMeta, grade, ctx }), values);
            return { output: { row: r.row || { ...values, id: r.id }, id: r.id, created: true, updated: 0 } };
        }
        const ins = queryCompiler.compileInsert(tableMeta, values, {
            createdBy: ctx.userId, orgId, dialect: 'pg',
        });
        await datatableDbStore.exec(scopeKey, scopeKey, ins.sql, ins.params);
        await datatableStore.bumpAfterWrite(table.id, scope, 1);
        // compileInsert mints the id and this used to throw it away, while the
        // variable picker (Builder/mapping/upstream.js) has always advertised
        // steps.<id>.output.row.id. Both save_row branches and add_row now
        // return ONE shape.
        return { output: { row: { ...values, id: ins.id }, id: ins.id, created: true, updated: 0 } };
    }

    // update_rows / delete_rows — both bounded by at least one resolved
    // condition (the validator requires it, and the skip above enforces it at
    // run time when a binding comes back empty).
    //
    // DATATABLE_MAX_LIMIT + 1 targets are selected, not DATATABLE_MAX_LIMIT:
    // the extra row is how the step knows the match was larger than it can
    // handle. Without it, `{deleted: 1000}` on a 5,000-row match reported
    // success for a job it had done a fifth of.
    const targets = queryCompiler.compileRecordList(tableMeta, {
        filters, match, limit: DATATABLE_MAX_LIMIT + 1, dialect: 'pg',
    }, writeFilter);
    const found = await datatableDbStore.query(scopeKey, scopeKey, targets.sql, targets.params);
    const allIds = (found.rows || []).map(r => r.id).filter(Boolean);
    const truncated = allIds.length > DATATABLE_MAX_LIMIT;
    const ids = allIds.slice(0, DATATABLE_MAX_LIMIT);

    if (truncated && op === 'delete_rows') {
        // A DESTRUCTIVE partial write that reports success is worse than a
        // failed step: nobody re-runs a green delete, so the remaining rows sit
        // there believed gone. An update is recoverable — it is reported as
        // truncated and the author can narrow the condition and run it again.
        throw fail(
            `This would delete more than ${DATATABLE_MAX_LIMIT} rows of "${table.name}" in one step. Narrow the conditions, or delete in batches.`,
            'datatable_too_many_rows',
        );
    }

    // A mirror's targets go to the source — in ONE write where the source
    // has a batch call (a file rewritten once), one at a time where it has
    // not — capped at MIRROR_WRITE_MAX_PER_STEP. Beyond the cap a delete
    // FAILS (same rule as above: a green partial delete is worse than a red
    // step) and an update reports `truncated`. The first refusal aborts the
    // step; the rows already changed are consistent on both sides.
    if (isMirror(table)) {
        const where = sources().sourceLabel(table);
        if (ids.length > MIRROR_WRITE_MAX_PER_STEP && op === 'delete_rows') {
            throw fail(
                `This would delete more than ${MIRROR_WRITE_MAX_PER_STEP} rows of the linked ${where} table "${table.name}" in one step. Narrow the conditions, or delete in batches.`,
                'datatable_too_many_rows',
            );
        }
        const wt = mirrorWrites(table);
        const mctx = mirrorCtx({ table, scope, scopeKey, tableMeta, grade, ctx });
        const slice = ids.slice(0, MIRROR_WRITE_MAX_PER_STEP);
        const done = op === 'delete_rows'
            ? (await wt.deleteRows(mctx, slice)).changed
            : (await wt.updateRows(mctx, slice.map(id => ({ id, values })))).changed;
        const cut = truncated || ids.length > MIRROR_WRITE_MAX_PER_STEP;
        return op === 'delete_rows'
            ? { output: { deleted: done, truncated: cut } }
            : { output: { updated: done, truncated: cut, ...(cut ? { warning: `Only the first ${slice.length} matching rows were changed — more matched.` } : {}) } };
    }

    // ONE transaction per chunk instead of one per row. 800 rows used to be
    // 801 round trips with no atomicity anywhere: a crash half way left half
    // the rows written and bumpAfterWrite never reached, so row_count kept
    // counting deletions that had happened.
    let n = 0;
    for (let i = 0; i < ids.length; i += WRITE_CHUNK) {
        const chunk = ids.slice(i, i + WRITE_CHUNK).map(id => (op === 'delete_rows'
            ? queryCompiler.compileDelete(tableMeta, id, writeFilter, PG)
            : queryCompiler.compileUpdate(tableMeta, id, values, writeFilter, { dialect: 'pg' })));
        const results = await datatableDbStore.batch(scopeKey, scopeKey,
            chunk.map(c => ({ sql: c.sql, params: c.params })));
        // pgAppEngine ALWAYS returns { changes: rowCount }, so the old
        // `res?.changes ? … : 1` fallback only ever lied: it counted a 0-row
        // statement as 1, and bumpAfterWrite then subtracted deletions that
        // never happened.
        let chunkChanges = 0;
        for (const r of (results || [])) chunkChanges += Number(r?.changes ?? 0);
        n += chunkChanges;
        // Bumped per chunk, inside the same flow: the chunk is committed, so
        // the counter has to move with it or a later chunk throwing leaves
        // row_count describing a table that no longer exists that way.
        // `0 - x`, not `-x`: with x === 0 the unary form yields -0, which
        // survives into the store's delta as a negative zero.
        await datatableStore.bumpAfterWrite(table.id, scope,
            op === 'delete_rows' ? 0 - chunkChanges : 0);
    }
    if (!ids.length) await datatableStore.bumpAfterWrite(table.id, scope, 0);
    const warning = truncated
        ? `Only the first ${DATATABLE_MAX_LIMIT} matching rows were changed — more matched.`
        : undefined;
    return op === 'delete_rows'
        ? { output: { deleted: n, truncated } }
        : { output: { updated: n, truncated, ...(warning ? { warning } : {}) } };
}

module.exports = { execDatatable, MIRROR_WRITE_MAX_PER_STEP, NC_WRITE_MAX_PER_STEP, _test: { readCursor } };
