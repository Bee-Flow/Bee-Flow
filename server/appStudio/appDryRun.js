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
const { SYSTEM_COLUMNS } = require('./dataModel');
const {
    DRY_RUN_LIMIT, dryRunFailure, isPlainObject, syntheticScope, resolveDryRunFilters,
    runRecordBinding, runAggregateBinding, runDatasetBinding,
} = require('./appDryRunReads');

// A viewer id that is deliberately NOT the owner, so an 'own'-scoped role sees
// only rows it created (none, for owner-seeded demo data) — that is exactly the
// "member sees an empty screen" signal the asRole pass exists to catch.
const ROLE_PROBE_VIEWER_ID = '__dry_run_role_probe__';
const DATA_STEP_KINDS = new Set(['create_record', 'update_record', 'delete_record']);

function findModelTable(dataModel, ref) {
    const tables = (dataModel && Array.isArray(dataModel.tables)) ? dataModel.tables : [];
    return tables.find((t) => t && (t.id === ref || t.key === ref)) || null;
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
            res = await run(binding, table, { roleArg, viewer, scope, app, ownerScope, deps, dataModel });
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
        readRecords: (ctx, table, opts) => require('./dataReadRunner').runRecordList(ctx, table, opts),
        readAggregate: (ctx, table, descriptor) => require('./dataReadRunner').runInlineAggregate(ctx, table, descriptor),
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

    // An unknown screen or role is the caller's mistake, not a clean app: say so
    // (app_screenshot refuses both the same way) instead of an ok:true with no bindings.
    const unknown = unknownTarget(def, dataModel, screenId, asRole);
    if (unknown) return unknown;

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
            // A filtered read that is empty says nothing about the table itself.
            if (ref && !b.filtered && !emptyTables.includes(ref)) emptyTables.push(ref);
            hints.push(`${b.nodeId || 'component'}.${b.prop} (${b.kind}) returned 0 rows${b.filtered ? ' with its filter' : ''} — seed data or fix the filter${ref ? ` on "${ref}"` : ''}.`);
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

/** An error result when screenId/asRole name something the app does not have. */
function unknownTarget(def, dataModel, screenId, asRole) {
    if (screenId) {
        const screens = Array.isArray(def && def.screens) ? def.screens.filter((x) => x && x.id) : [];
        if (!screens.some((x) => x.id === screenId)) {
            return { ok: false, error: `Unknown screenId ${JSON.stringify(screenId)}.`, _fixHint: `Screens: ${screens.map((x) => x.id).join(', ') || '(none)'}.` };
        }
    }
    if (asRole) {
        const roles = (dataModel && Array.isArray(dataModel.roles)) ? dataModel.roles.filter((r) => r && r.key) : [];
        if (!roles.some((r) => r.key === asRole)) {
            return { ok: false, error: `Unknown asRole ${JSON.stringify(asRole)}.`, _fixHint: `Roles: ${roles.map((r) => r.key).join(', ') || '(none defined)'}.` };
        }
    }
    return null;
}

/** The table id/key a record/records binding finding referred to (for emptyTables). */
function bindingTableRef(collected, finding) {
    const match = collected.find((c) => c.nodeId === finding.nodeId && c.prop === finding.prop && c.binding.kind === finding.kind);
    return match ? (match.binding.tableId ?? null) : null;
}

module.exports = {
    appDryRun,
    DRY_RUN_LIMIT,
    dryRunFailure,
    ROLE_PROBE_VIEWER_ID,
    // exposed for tests
    _test: { resolveDryRunFilters, syntheticScope, collectDataSteps, checkDataStep, runActionPass, findModelTable },
};
