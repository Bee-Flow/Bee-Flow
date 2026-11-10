// @typecheck
/**
 * App Studio dry-run: the DATA reads of one binding (record / aggregate /
 * dataset) and the synthetic scope their filters resolve against. Split out of
 * appDryRun.js; that file wires these into the four passes.
 *
 * Like the rest of the dry run this produces no SQL and no access predicate of
 * its own: queryCompiler, rlsGateway, datasetCache and dataReadRunner do.
 */

'use strict';

const queryCompiler = require('./queryCompiler');
const rlsGateway = require('./rlsGateway');
const { seedVariableDefaults } = require('./componentSpecs');
const { DRY_RUN_PLAN, planFilters } = require('../shared/appDefinition/bindingPlan.mjs');
const { isDatatableBacked } = require('./datatableSource');
const { recordListDescriptor, aggregateDescriptor } = require('../core/dataEngine/readDescriptor.mts');
const { queryWithComputed } = require('../core/dataEngine/computedRead.mts');
const log = require('../telemetry/log');

// Read-only probe page — a couple of rows is enough to prove a binding returns
// SOMETHING (or nothing); we never render the data.
const DRY_RUN_LIMIT = 3;

function isPlainObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

/**
 * The synthetic expression scope a formula filter resolves against.
 *
 * `vars` is seeded from the app's DECLARED variables rather than left empty.
 * With `{}` a filter like {value:{kind:'formula',expr:'vars.status'}} resolved
 * to undefined, the entry was omitted, and the dry run probed the UNFILTERED
 * query — reporting a row count the real screen will never show.
 */
function syntheticScope(currentUser, variables) {
    const now = Date.now();
    return {
        currentUser,
        vars: seedVariableDefaults(variables),
        forms: {},
        screen: { params: {} },
        now,
        today: new Date(now).toISOString().slice(0, 10),
    };
}

/**
 * Resolve a record/records binding's filter for the dry-run: the shared binding
 * planner with the dry run's own option set (DRY_RUN_PLAN), against the
 * synthetic scope:
 *   • isNull/isNotNull entries pass through untouched;
 *   • a {kind:'formula',expr} value referencing a root the synthetic owner/role
 *     scope cannot populate (item/index/value in a repeater, the current
 *     `form`, actions/records/datasets), or one that does not compile → the
 *     WHOLE binding is skipped (dynamic — can't simulate it, and a bad formula
 *     is a STATIC error);
 *   • a formula that resolves to undefined/null has its entry OMITTED;
 *   • literals pass through, `required` is not enforced;
 *   • a legacy whole-filter formula string references live scope → skipped.
 * Returns { filters } (an array, possibly empty) or { skipped:true }.
 */
function resolveDryRunFilters(binding, scope) {
    const step = planFilters(binding, scope, DRY_RUN_PLAN);
    if (step.plan !== 'fetch') return { skipped: true };
    return { filters: /** @type {{ filter?: unknown[] }} */ (step.binding).filter };
}

const GENERIC_READ_FAILURE = 'The data read failed on the server (details are in the server log).';

/**
 * Turn a thrown read error into a per-binding finding. Only messages that were
 * written for a reader pass through: an access refusal, a compiler complaint
 * about the author's own field names, or a `safe` read refusal. Anything else is
 * a database error whose text names internal relations, so the client gets a
 * generic sentence and the detail goes to the log.
 */
function bindingFailure(e, binding) {
    if (e instanceof rlsGateway.AccessError) return { ok: true, rowCount: 0, note: 'no read access for this role' };
    if (e instanceof queryCompiler.CompileError || (e && e.safe === true)) return { ok: false, error: e.message };
    log.warn('app dry run: a binding read failed', { kind: binding.kind, tableId: binding.tableId, error: e && e.message ? e.message : String(e) });
    return { ok: false, error: GENERIC_READ_FAILURE };
}

/** rowCount + the honesty flags: `sampled` (the real count may be higher), `filtered`. */
function readSummary(rows, resolvedFilters, sampled) {
    const filtered = Array.isArray(resolvedFilters) && resolvedFilters.length > 0;
    return {
        ok: true,
        rowCount: Math.min(rows.length, DRY_RUN_LIMIT),
        ...(sampled ? { sampled: true, sampleLimit: DRY_RUN_LIMIT } : {}),
        ...(filtered ? { filtered: true } : {}),
    };
}

/** Context for the shared read runner (linked Studio tables). */
function linkedReadCtx(app, ownerScope, dataModel, roleArg, viewer) {
    return { app, ownerScope, viewerId: viewer && viewer.id, role: roleArg, viewer, model: dataModel };
}

/**
 * Execute one record/records binding read-only and return the per-binding
 * finding fields ({ ok, rowCount } | { ok, error } | { skipped }).
 */
async function runRecordBinding(binding, table, { roleArg, viewer, scope, app, ownerScope, deps, dataModel }) {
    const resolved = resolveDryRunFilters(binding, scope);
    if (resolved.skipped) return { ok: true, skipped: 'dynamic' };
    const descriptor = recordListDescriptor(binding, { filters: resolved.filters, limit: DRY_RUN_LIMIT });
    try {
        if (isDatatableBacked(table)) {
            // The rows are in a Studio table, not the per-app database: read them
            // the way the runtime does. Its access follows the Studio table, so a
            // synthetic app role has nothing to say about it.
            if (roleArg !== 'owner') return { ok: true, skipped: 'linked' };
            const ctx = linkedReadCtx(app, ownerScope, dataModel, roleArg, viewer);
            const out = await deps.readRecords(ctx, table, descriptor);
            const rows = Array.isArray(out && out.records) ? out.records : [];
            return readSummary(rows, resolved.filters, !!(out && out.nextCursor));
        }
        const accessFilter = rlsGateway.compileAccessFilter(table, roleArg, viewer, 'read');
        const compiled = queryCompiler.compileRecordList(table, { ...descriptor, readTimeComputed: true }, accessFilter);
        const { result: out, notes } = await queryWithComputed(
            (/** @type {string} */ sql, /** @type {unknown[]} */ params) => deps.dbQuery(ownerScope, app.id, sql, params), compiled);
        const rows = Array.isArray(out && out.rows) ? out.rows : [];
        // A read-time computed field that reads empty is named, so the author sees it here.
        return { ...readSummary(rows, resolved.filters, rows.length > DRY_RUN_LIMIT), ...(notes.length ? { notes } : {}) };
    } catch (e) {
        return bindingFailure(e, binding);
    }
}

/**
 * Execute one AGGREGATE binding read-only.
 *
 * It needs its own compiler call, and that is the whole point of this function.
 * Every non-dataset binding goes through compileRecordList — which
 * resolves `sort.field` against the table's real columns. An aggregate sorts by
 * its own OUTPUT: `count`, `aanvragen`, a bucketed `day`. Those are aliases, not
 * columns, so a perfectly good chart came back as `unknown field: count` and the
 * dry run reported four working dashboard tiles as broken.
 *
 * A check that cries wolf is worse than no check: it teaches you to skim past
 * findings, which is exactly when the real one goes by. compileAggregate is also
 * what the live /data/query route runs, so what passes here is what runs.
 */
async function runAggregateBinding(binding, table, { roleArg, viewer, scope, app, ownerScope, deps, dataModel }) {
    const resolved = resolveDryRunFilters(binding, scope);
    if (resolved.skipped) return { ok: true, skipped: 'dynamic' };
    const descriptor = aggregateDescriptor(binding, {
        filters: resolved.filters,
        limit: DRY_RUN_LIMIT + 1, // one more than shown, so exactly-3 is not "sampled"
    });
    try {
        if (isDatatableBacked(table)) {
            if (roleArg !== 'owner') return { ok: true, skipped: 'linked' };
            const ctx = linkedReadCtx(app, ownerScope, dataModel, roleArg, viewer);
            const out = await deps.readAggregate(ctx, table, descriptor);
            const rows = Array.isArray(out && out.rows) ? out.rows : [];
            return readSummary(rows, resolved.filters, rows.length > DRY_RUN_LIMIT);
        }
        const accessFilter = rlsGateway.compileAccessFilter(table, roleArg, viewer, 'read');
        const { sql, params } = queryCompiler.compileAggregate(table, descriptor, accessFilter);
        const out = await deps.dbQuery(ownerScope, app.id, sql, params);
        const rows = Array.isArray(out && out.rows) ? out.rows : [];
        return readSummary(rows, resolved.filters, rows.length > DRY_RUN_LIMIT);
    } catch (e) {
        return bindingFailure(e, binding);
    }
}

/** Execute one dataset binding read-only via datasetCache.runDataset. */
async function runDatasetBinding(binding, { dataModel, app, viewer, appId, ownerId, deps }) {
    try {
        const ds = await deps.getDataset(binding.datasetId, appId, ownerId);
        if (!ds) return { ok: true, skipped: 'unresolved' }; // STATIC flags unknown_dataset
        const out = await deps.runDataset(app, dataModel, ds, viewer, { refresh: true });
        const rows = Array.isArray(out && out.rows) ? out.rows : [];
        return { ok: true, rowCount: rows.length };
    } catch (e) {
        return bindingFailure(e, binding);
    }
}

/**
 * The tool result when the dry run itself threw (a store or database outage).
 * The message can name internal relations: it goes to the log, the model gets a
 * generic sentence.
 */
function dryRunFailure(e, appId) {
    log.warn('app_dry_run failed', { appId: appId || null, error: e && e.message ? e.message : String(e) });
    return {
        error: 'Dry-run failed: the app data could not be read (details are in the server log).',
        _fixHint: 'This is a transient read error — retry app_dry_run, or continue with app_finalize (which re-runs the static checks).',
    };
}

module.exports = {
    dryRunFailure,
    DRY_RUN_LIMIT,
    isPlainObject,
    syntheticScope,
    resolveDryRunFilters,
    runRecordBinding,
    runAggregateBinding,
    runDatasetBinding,
};

/**
 * @typedef {import('./builderTools/dataTools').DataModel} DataModel
 * @typedef {import('./builderTools/dataTools').DataTable} DataTable
 * @typedef {{ id: string, userId: string }} DryRunApp  the studio_apps row (the fields the dry run reads)
 * @typedef {{ id?: string|null, role?: string }} DryRunViewer
 * @typedef {{ [k: string]: unknown, kind?: string, tableId?: string, datasetId?: string,
 *   groupBy?: Array<{ field?: string, bucket?: string, as?: string }>, aggregates?: Array<{ fn?: string, field?: string, as?: string }> }} DryRunBinding  a record / records / aggregate / dataset binding (an aggregate's groupBy/aggregates as the validator accepts them)
 * @typedef {{ ok?: boolean, skipped?: string, rowCount?: number, note?: string, error?: string, sampled?: boolean, sampleLimit?: number, filtered?: boolean }} ReadFinding
 * @typedef {{
 *   dbQuery: (ownerScope: string, appId: string, sql: string, params: unknown[]) => Promise<{ rows?: unknown[] }>,
 *   runDataset: (app: DryRunApp, model: DataModel, ds: object, viewer: DryRunViewer, opts?: object) => Promise<{ rows?: unknown[] }>,
 *   getDataset: (datasetId: string, appId: string, ownerId: string) => Promise<object|null>,
 *   readRecords: (ctx: import('./dataReadRunner').ReadCtx, table: DataTable, opts: object) => Promise<{ records?: unknown[], nextCursor?: unknown }>,
 *   readAggregate: (ctx: import('./dataReadRunner').ReadCtx, table: DataTable, descriptor: object) => Promise<{ rows?: unknown[] }>,
 * }} DryRunDeps
 */
