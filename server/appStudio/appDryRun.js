/**
 * App Studio — dry-run self-repair (Wave 4).
 *
 * Before app_finalize the builder can call app_dry_run to actually EXECUTE the
 * app's data bindings read-only (as the owner AND, optionally, as a role) so
 * "component bound to an empty table", "a member sees an empty screen" and
 * "a sequence step writes a missing field" surface BEFORE the user ever runs
 * the app. Four passes:
 *
 *   1. STATIC  — data-aware validateAppDefinition (the binding.unknown_* /
 *                step.unknown_* records). Hard cross-ref checker.
 *   2. DATA    — every record/records/dataset binding on the target screen(s)
 *                executed read-only (limit 3) as the OWNER through the ONLY
 *                read paths: queryCompiler.compileRecordList + rlsGateway
 *                .compileAccessFilter, or datasetCache.runDataset. Formula-valued
 *                filters ({kind:'formula',expr}) have no server resolver, so they
 *                resolve against a SYNTHETIC owner scope with the SHARED expr
 *                engine; a formula referencing a root the synthetic scope can't
 *                populate marks the binding { skipped:'dynamic' } (never errors).
 *   3. asROLE  — when asRole is given AND exists in dataModel.roles, re-run the
 *                data pass with that role's compiled access filter, from a
 *                SYNTHETIC non-owner viewer, so owner-seeded rows invisible under
 *                an 'own'-scoped role show up as an empty role view.
 *   4. ACTIONS — static-check every sequence create/update/delete_record step
 *                against the model (table exists, values keys are real field
 *                keys). NEVER executes a mutation.
 *
 * Result:
 *   { ok, static:{errors,warnings}, bindings:[…], roleFindings:[…], actions:[…],
 *     emptyTables:[…], _hints:[…] }
 * ok = STATIC clean AND no owner-binding EXECUTION error. Zero rows is a WARNING
 * hint (surfaced in _hints / emptyTables), never an error — an empty demo table
 * must not block finalize.
 *
 * Read-path invariant: this module produces NO SQL and NO access predicate of
 * its own — queryCompiler is the only SQL producer, rlsGateway the only
 * access-filter producer, datasetCache the only dataset runner. It only wires
 * them together. The DB edge (studioAppDbStore.query / datasetCache.runDataset /
 * studioAppDataStore.getDataset) is injectable so the tests exercise the pass
 * logic without a database.
 */

'use strict';

const { validateAppDefinition } = require('./validate');
const { collectDataBindings } = require('./collectDataBindings');
const queryCompiler = require('./queryCompiler');
const rlsGateway = require('./rlsGateway');
const { SYSTEM_COLUMNS } = require('./dataModel');
const { seedVariableDefaults } = require('./componentSpecs');
const { compile, tryEvaluate } = require('../automation/expr');

// Read-only probe page — a couple of rows is enough to prove a binding returns
// SOMETHING (or nothing); we never render the data.
const DRY_RUN_LIMIT = 3;

// A viewer id that is deliberately NOT the owner, so an 'own'-scoped role sees
// only rows it created (none, for owner-seeded demo data) — that is exactly the
// "member sees an empty screen" signal the asRole pass exists to catch.
const ROLE_PROBE_VIEWER_ID = '__dry_run_role_probe__';

// The scope roots the synthetic owner/role scope can populate. A formula filter
// value referencing anything else (item/index/value in a repeater, the current
// `form`, actions/records/datasets) can't be simulated statically → the binding
// is reported skipped:'dynamic' rather than run with a wrong value.
const SYNTHETIC_SCOPE_ROOTS = new Set(['currentUser', 'vars', 'forms', 'screen', 'now', 'today']);
const NO_VALUE_FILTER_OPS = new Set(['isNull', 'isNotNull']);
const DATA_STEP_KINDS = new Set(['create_record', 'update_record', 'delete_record']);

function isPlainObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

function findModelTable(dataModel, ref) {
    const tables = (dataModel && Array.isArray(dataModel.tables)) ? dataModel.tables : [];
    return tables.find((t) => t && (t.id === ref || t.key === ref)) || null;
}

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
 * Resolve a record/records binding's filter for the dry-run, mirroring the
 * client resolveBindingFilters contract against the synthetic scope:
 *   • isNull/isNotNull entries pass through untouched;
 *   • a {kind:'formula',expr} value referencing a non-populatable root → the
 *     WHOLE binding is skipped (dynamic — can't simulate it);
 *   • a formula that resolves to undefined/null has its entry OMITTED;
 *   • literals pass through.
 * Returns { filters } (an array, possibly empty) or { skipped:true }.
 */
function resolveDryRunFilters(binding, scope) {
    const filter = binding.filter;
    if (filter === undefined || filter === null) return { filters: undefined };
    // A legacy whole-filter formula string references live scope — can't simulate.
    if (typeof filter === 'string') return { skipped: true };
    if (!Array.isArray(filter)) return { filters: undefined };

    const out = [];
    for (const entry of filter) {
        if (!isPlainObject(entry)) { out.push(entry); continue; }
        if (NO_VALUE_FILTER_OPS.has(entry.op)) { out.push(entry); continue; }
        const v = entry.value;
        if (isPlainObject(v) && v.kind === 'formula') {
            let refs;
            try { refs = compile(String(v.expr || '')).refs; }
            catch { return { skipped: true }; } // a bad formula is a STATIC error; skip data
            if (refs.some((r) => !SYNTHETIC_SCOPE_ROOTS.has(r))) return { skipped: true };
            const { value } = tryEvaluate(v.expr, scope);
            if (value === undefined || value === null) continue; // omit — matches the client
            out.push({ ...entry, value });
        } else {
            out.push(entry);
        }
    }
    return { filters: out };
}

/**
 * Execute one record/records binding read-only and return the per-binding
 * finding fields ({ ok, rowCount } | { ok, error } | { skipped }).
 */
async function runRecordBinding(binding, table, { roleArg, viewer, scope, app, ownerScope, deps }) {
    const resolved = resolveDryRunFilters(binding, scope);
    if (resolved.skipped) return { ok: true, skipped: 'dynamic' };
    try {
        const accessFilter = rlsGateway.compileAccessFilter(table, roleArg, viewer, 'read');
        const { sql, params } = queryCompiler.compileRecordList(
            table,
            { filters: resolved.filters, sort: binding.sort, limit: DRY_RUN_LIMIT },
            accessFilter,
        );
        const out = await deps.dbQuery(ownerScope, app.id, sql, params);
        const rows = Array.isArray(out && out.rows) ? out.rows : [];
        return { ok: true, rowCount: Math.min(rows.length, DRY_RUN_LIMIT) };
    } catch (e) {
        if (e instanceof rlsGateway.AccessError) return { ok: true, rowCount: 0, note: 'no read access for this role' };
        return { ok: false, error: e && e.message ? e.message : String(e) };
    }
}

/**
 * Execute one AGGREGATE binding read-only.
 *
 * It needs its own compiler call, and that is the whole point of this function.
 * Every non-dataset binding used to go through compileRecordList — which
 * resolves `sort.field` against the table's real columns. An aggregate sorts by
 * its own OUTPUT: `count`, `aanvragen`, a bucketed `day`. Those are aliases, not
 * columns, so a perfectly good chart came back as `unknown field: count` and the
 * dry run reported four working dashboard tiles as broken.
 *
 * A check that cries wolf is worse than no check: it teaches you to skim past
 * findings, which is exactly when the real one goes by. compileAggregate is also
 * what the live /data/query route runs, so what passes here is what runs.
 */
async function runAggregateBinding(binding, table, { roleArg, viewer, scope, app, ownerScope, deps }) {
    const resolved = resolveDryRunFilters(binding, scope);
    if (resolved.skipped) return { ok: true, skipped: 'dynamic' };
    try {
        const accessFilter = rlsGateway.compileAccessFilter(table, roleArg, viewer, 'read');
        const { sql, params } = queryCompiler.compileAggregate(
            table,
            {
                filters: resolved.filters,
                groupBy: binding.groupBy,
                aggregates: binding.aggregates,
                sort: binding.sort,
                limit: DRY_RUN_LIMIT,
            },
            accessFilter,
        );
        const out = await deps.dbQuery(ownerScope, app.id, sql, params);
        const rows = Array.isArray(out && out.rows) ? out.rows : [];
        return { ok: true, rowCount: Math.min(rows.length, DRY_RUN_LIMIT) };
    } catch (e) {
        if (e instanceof rlsGateway.AccessError) return { ok: true, rowCount: 0, note: 'no read access for this role' };
        return { ok: false, error: e && e.message ? e.message : String(e) };
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
        if (e instanceof rlsGateway.AccessError) return { ok: true, rowCount: 0, note: 'no read access for this role' };
        return { ok: false, error: e && e.message ? e.message : String(e) };
    }
}

/**
 * Run the DATA pass over the collected bindings for one identity (owner or a
 * role). Returns the per-binding finding array.
 */
async function runDataPass(collected, { dataModel, app, roleArg, viewer, ownerScope, appId, ownerId, deps, variables }) {
    const scope = syntheticScope(viewer, variables);
    const findings = [];
    for (const { nodeId, prop, binding } of collected) {
        const base = { nodeId, prop, kind: binding.kind };
        if (!app) { findings.push({ ...base, ok: true, skipped: 'no_data' }); continue; }
        let res;
        if (binding.kind === 'dataset') {
            res = await runDatasetBinding(binding, { dataModel, app, viewer, appId, ownerId, deps });
        } else {
            const table = findModelTable(dataModel, binding.tableId);
            if (!table) { findings.push({ ...base, ok: true, skipped: 'unresolved' }); continue; } // STATIC flags unknown_table
            const run = binding.kind === 'aggregate' ? runAggregateBinding : runRecordBinding;
            res = await run(binding, table, { roleArg, viewer, scope, app, ownerScope, deps });
        }
        findings.push({ ...base, ...res });
    }
    return findings;
}

// ── ACTION pass — static-only sequence data-step checks ──────────────

/** Deep-scan a sequence action for its create/update/delete_record steps. */
function collectDataSteps(action) {
    const out = [];
    const visit = (v) => {
        if (!v || typeof v !== 'object') return;
        if (Array.isArray(v)) { for (const x of v) visit(x); return; }
        if (typeof v.kind === 'string' && DATA_STEP_KINDS.has(v.kind)) out.push(v);
        for (const x of Object.values(v)) visit(x);
    };
    visit(action && action.steps);
    return out;
}

/** Check one data step's table + written field keys against the model. */
function checkDataStep(step, dataModel) {
    const errors = [];
    const table = findModelTable(dataModel, step.tableId);
    if (!table) {
        errors.push(`references table ${JSON.stringify(step.tableId)} which is not in the data model`);
        return { tableId: step.tableId ?? null, errors };
    }
    if ((step.kind === 'create_record' || step.kind === 'update_record') && isPlainObject(step.values)) {
        const keys = new Set((table.fields || []).map((f) => f && f.key).filter(Boolean));
        for (const col of Object.keys(step.values)) {
            if (SYSTEM_COLUMNS.includes(col)) errors.push(`writes server-managed system column ${JSON.stringify(col)}`);
            else if (!keys.has(col)) errors.push(`writes field ${JSON.stringify(col)} which does not exist on table "${table.key}"`);
        }
    }
    return { tableId: table.id, errors };
}

function runActionPass(def, dataModel) {
    const actions = isPlainObject(def && def.actions) ? def.actions : {};
    const out = [];
    for (const [actionId, action] of Object.entries(actions)) {
        if (!action || action.kind !== 'sequence') continue;
        for (const step of collectDataSteps(action)) {
            const { tableId, errors } = checkDataStep(step, dataModel);
            out.push({ actionId, step: step.kind, tableId, ok: errors.length === 0, ...(errors.length ? { errors } : {}) });
        }
    }
    return out;
}

// ── Default DB edge (injectable for tests) ───────────────────────────

function defaultDeps() {
    return {
        dbQuery: (ownerScope, appId, sql, params) =>
            require('../stores/studioAppDbStore').query(ownerScope, appId, sql, params),
        runDataset: (app, model, ds, viewer, opts) =>
            require('./datasetCache').runDataset(app, model, ds, viewer, opts),
        getDataset: (datasetId, appId, ownerId) =>
            require('../stores/studioAppDataStore').getDataset(datasetId, appId, ownerId),
    };
}

/**
 * Run a full dry-run.
 *
 * @param {object} input
 * @param {object}  input.def       — canonical app definition
 * @param {object}  [input.dataModel]— the app's data model (or null)
 * @param {Array}   [input.datasets]— dataset ids ([{id}] or [id]) for the STATIC pass
 * @param {object}  [input.app]     — the studio_apps row (needed for the DATA pass; null → data pass skipped)
 * @param {string}  [input.ownerId] — the app owner's user id
 * @param {object}  [input.deps]    — { dbQuery, runDataset, getDataset } overrides
 * @param {object} [opts]
 * @param {string}  [opts.screenId] — narrow the DATA pass to one screen
 * @param {string}  [opts.asRole]   — re-run the DATA pass as this role (when it exists)
 */
async function appDryRun(input = {}, opts = {}) {
    const { def, dataModel = null, datasets = [], datatables = null, app = null, ownerId = null } = input;
    const { screenId = null, asRole = null } = opts;
    const deps = { ...defaultDeps(), ...(input.deps || {}) };
    const appId = app ? app.id : (input.appId ?? null);
    const ownerScope = app ? app.userId : ownerId;

    // 1. STATIC — the data-aware cross-ref checker (unknown table/dataset/field).
    // `datatables` (de Studio-tabellen die de eigenaar heeft) rijdt mee zodat de
    // droogloop dezelfde harde fout geeft als het publiceren, in plaats van de
    // waarschuwing die je krijgt als niemand de lijst meestuurde.
    const staticResult = validateAppDefinition(def, { dataModel, datasets, datatables });
    const staticOut = { errors: staticResult.errors, warnings: staticResult.warnings };

    // 2. DATA (owner) — every record/records/dataset binding on the target screen.
    const collected = collectDataBindings(def, screenId);
    const ownerViewer = { id: ownerId };
    const bindings = await runDataPass(collected, {
        dataModel, app, roleArg: 'owner', viewer: ownerViewer, ownerScope, appId, ownerId, deps,
        variables: def.variables,
    });

    // 3. asROLE — only for a role that actually exists in the model.
    const roles = (dataModel && Array.isArray(dataModel.roles)) ? dataModel.roles : [];
    const roleExists = asRole && roles.some((r) => r && r.key === asRole);
    let roleFindings = [];
    if (roleExists) {
        const roleViewer = { id: ROLE_PROBE_VIEWER_ID, role: asRole };
        const raw = await runDataPass(collected, {
            dataModel, app, roleArg: asRole, viewer: roleViewer, ownerScope, appId, ownerId, deps,
            variables: def.variables,
        });
        roleFindings = raw.map((f) => ({ role: asRole, ...f }));
    }

    // 4. ACTIONS — static data-step checks (never mutates).
    const actions = runActionPass(def, dataModel);

    // Empty-table hints — 0-row OWNER bindings surface for seeding/filter fixes.
    const emptyTables = [];
    const hints = [];
    for (const b of bindings) {
        if (b.rowCount === 0 && b.kind !== 'dataset') {
            const ref = bindingTableRef(collected, b);
            if (ref && !emptyTables.includes(ref)) emptyTables.push(ref);
            hints.push(`${b.nodeId || 'component'}.${b.prop} (${b.kind}) returned 0 rows — seed data or fix the filter${ref ? ` on "${ref}"` : ''}.`);
        } else if (b.rowCount === 0 && b.kind === 'dataset') {
            hints.push(`${b.nodeId || 'component'}.${b.prop} (dataset) returned 0 rows — the dataset is empty (seed the source table) or its filters exclude everything.`);
        }
    }
    for (const f of roleFindings) {
        if (f.rowCount === 0) {
            hints.push(`role "${f.role}" sees 0 rows for ${f.nodeId || 'component'}.${f.prop} (${f.kind}) — under this role's access${f.note ? ` (${f.note})` : ''} the screen is empty. Use access.default "app" for shared data, or seed rows this role can see.`);
        }
    }
    for (const a of actions) {
        if (!a.ok) hints.push(`action ${a.actionId} ${a.step}: ${(a.errors || []).join('; ')}.`);
    }

    const ok = staticOut.errors.length === 0 && bindings.every((b) => b.ok !== false);

    return {
        ok,
        static: staticOut,
        bindings,
        roleFindings,
        actions,
        emptyTables,
        ...(hints.length ? { _hints: hints } : {}),
    };
}

/** The table id/key a record/records binding finding referred to (for emptyTables). */
function bindingTableRef(collected, finding) {
    const match = collected.find((c) => c.nodeId === finding.nodeId && c.prop === finding.prop && c.binding.kind === finding.kind);
    return match ? (match.binding.tableId ?? null) : null;
}

module.exports = {
    appDryRun,
    DRY_RUN_LIMIT,
    ROLE_PROBE_VIEWER_ID,
    // exposed for tests
    _test: { resolveDryRunFilters, syntheticScope, collectDataSteps, checkDataStep, runActionPass, findModelTable },
};
