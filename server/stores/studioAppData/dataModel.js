// @typecheck
/**
 * The data model of an App Studio app: optimistic (CAS) save with the schema
 * migration handed to the per-app engine, drift reconcile, and the additive
 * form a Solution stage takes. Data versions and row counts: rowCounts.js.
 */

const { getOne, getClient } = require('../../db');
const { deps } = require('./cycleDeps');
const { isPg } = require('../../utils/engineFlag');
const log = require('../../telemetry/log');
const { parseJSON } = require('../lib/json');
const { storeError } = require('../lib/managedParts');
const { initDB } = require('./schema');
const { mapMetaRow } = require('./rowMappers');
const { recountRows, bumpDataVersion } = require('./rowCounts');
const { buildMigrationReport, applyPlanned, previewAgainst } = require('./migrationPreview.mts');
const { bestEffort } = require('../../utils/bestEffort');

// The data-model contract (appStudio/dataModel) sits in the server's import
// cycle; the barrel hands it in through cycleDeps.
const migrationPlan = (...a) => deps.dataModel.migrationPlan(...a);
const planMigration = (...a) => deps.dataModel.planMigration(...a);
const validateDataModel = (...a) => deps.dataModel.validateDataModel(...a);
const emptyDataModel = (...a) => deps.dataModel.emptyDataModel(...a);

// ── Data model (CAS + migration) ────────────────────────────────────

/**
 * The app's data model + versions/counts, scoped to the owner.
 * With { reconcile:true } a best-effort reconcileDataModel runs FIRST (drift
 * detection + row recount for the SQLite-ahead-of-Postgres window) — a
 * reconcile failure never breaks the read.
 */
async function getDataModel(appId, ownerId, { reconcile = false } = {}) {
    await initDB();
    if (reconcile) {
        try {
            await reconcileDataModel(appId, ownerId);
        } catch (e) {
            log.warn(`[StudioAppDataStore] reconcile failed for ${appId}: ${/** @type {Error} */ (e).message}`);
        }
    }
    const r = await getOne(
        `SELECT * FROM studio_app_data_meta WHERE app_id = $1 AND owner_user_id = $2`,
        [appId, ownerId]
    );
    return r ? mapMetaRow(r) : null;
}

/**
 * Detect and report the SQLite-ahead-of-Postgres residual window. saveDataModel
 * stamps PRAGMA user_version = the new model_version INSIDE the SQLite
 * migration transaction, before the Postgres commit — so a PG COMMIT failure
 * leaves user_version > model_version. When that drift is seen, log it and run
 * recountRows (authoritative counts regardless of what the orphaned migration
 * did). The schema itself heals on the next saveDataModel: the replayed plan
 * executes tolerantly (already-applied signatures are skipped) and re-stamps
 * user_version, clearing the drift.
 *
 * Returns { ok:true, drift, sqliteVersion, modelVersion } or
 * { ok:false, notFound:true } / { ok:false, error } when unreadable.
 */
async function reconcileDataModel(appId, ownerId) {
    await initDB();
    const meta = await getDataModel(appId, ownerId);
    if (!meta) return { ok: false, notFound: true };
    // Under Postgres the schema change and the model row commit TOGETHER
    // (saveDataModel passes its client into applyMigration), so there is no
    // window in which they can disagree. Report "no drift" rather than reading
    // a stamp whose whole purpose was to detect a window that cannot open.
    if (isPg()) {
        return { ok: true, drift: false, sqliteVersion: meta.modelVersion, modelVersion: meta.modelVersion };
    }
    let sqliteVersion = 0;
    try {
        sqliteVersion = await deps.studioAppDbStore.getSchemaStamp(ownerId, appId);
    } catch (e) {
        log.warn(`[StudioAppDataStore] reconcile: user_version read failed for ${appId}: ${/** @type {Error} */ (e).message}`);
        return { ok: false, error: /** @type {Error} */ (e).message };
    }
    const modelVersion = meta.modelVersion;
    const drift = sqliteVersion > modelVersion;
    if (drift) {
        log.warn(
            `[StudioAppDataStore] reconcile ${appId}: SQLite user_version=${sqliteVersion} ` +
            `is ahead of model_version=${modelVersion} — recounting rows`
        );
        try {
            await recountRows(appId, ownerId, Array.isArray(meta.model && meta.model.tables) ? meta.model.tables : []);
        } catch (e) {
            log.warn(`[StudioAppDataStore] reconcile recount failed for ${appId}: ${/** @type {Error} */ (e).message}`);
        }
    }
    return { ok: true, drift, sqliteVersion, modelVersion };
}

/**
 * Persist a new data model with optimistic concurrency, applying the schema
 * diff to the per-app SQLite database.
 *
 * Flow (SQLite-first, atomic): under a Postgres row lock we compute
 * migrationPlan(current, new) and apply it via studioAppDbStore.applyMigration
 * — one all-or-nothing SQLite transaction that ALSO stamps
 * PRAGMA user_version = the next model_version — BEFORE bumping the persisted
 * model + model_version. If the migration throws, nothing is persisted and the
 * SQLite schema (incl. the stamp) is unchanged (its txn rolled back), so old
 * model ↔ old schema stays consistent. The residual window — a Postgres COMMIT
 * failing AFTER a successful SQLite migration (schema ahead of model) — is
 * self-healing:
 *   • it is detectable as user_version > model_version;
 *     reconcileDataModel() reports it and recounts rows, and runs lazily via
 *     getDataModel(appId, ownerId, { reconcile:true }) on the read path;
 *   • retrying the save replays a plan whose statements are already applied —
 *     applyMigration executes it tolerantly (dataModel.applyPlanTolerantly
 *     skips exact already-applied signatures) and re-stamps user_version,
 *     which clears the drift.
 *
 * On an app of a Solution stage (stores/lib/managedParts.js) the model is
 * changed by a deploy only: without `opts.managedWrite` (an active
 * deployment of that stage) the save throws 409 managed_part. A stage's model
 * is ADDITIVE ONLY, whether or not the caller asks for it (`additiveOnly`,
 * see additiveModel below): the deploy applies it in its prepare phase,
 * outside the atomic commit, so the older release must keep working on it.
 *
 * `opts.convertTypes` (default false) converts a field whose type changed in
 * place when the pair is safe (core/dataEngine/dataModel/fieldConversion.mts);
 * `opts.onUnconvertible` 'refuse' (default) refuses the save when a value
 * cannot convert, 'clear' empties those values. Never on a stage: an additive
 * save or a capability lock converts nothing (a type change stays model-only).
 *
 * Returns:
 *   { ok:true, version, report }                           on success (report:
 *                                                          migrationPreview.buildMigrationReport)
 *   { ok:false, conversionRefused:true, conversions }      values cannot convert (refuse mode)
 *   { ok:false, migrationFailed:true, failure }            a recompute/convert statement failed
 *                                                          (fixed reason, never the DB's text)
 *   { ok:false, invalid:true, errors }                     model failed validation
 *   { ok:false, conflict:true, currentVersion, model }     expectedVersion mismatch
 *   { ok:false, notFound:true }                            app not owned / missing
 */
/**
 * @returns {Promise<SaveDataModelResult>}
 */
async function saveDataModelIn(io, appId, ownerId, model, { expectedVersion = null, managedWrite = null, additiveOnly = false, convertTypes = false, onUnconvertible = 'refuse' } = {}) {
    await io.ready();
    const { errors } = validateDataModel(model);
    if (errors.length) return { ok: false, invalid: true, errors };

    const client = await io.getClient();
    try {
        await client.query('BEGIN');
        const cur = await client.query(
            `SELECT owner_user_id, model, model_version FROM studio_app_data_meta WHERE app_id = $1 FOR UPDATE`,
            [appId]
        );

        let currentModel;
        /** @type {number} */
        let currentVersion;
        /** @type {boolean} */
        let metaExists;
        if (cur.rows.length > 0) {
            if (cur.rows[0].owner_user_id !== ownerId) {
                await client.query('ROLLBACK');
                return { ok: false, notFound: true };
            }
            currentModel = parseJSON(cur.rows[0].model, emptyDataModel());
            currentVersion = parseInt(cur.rows[0].model_version) || 0;
            metaExists = true;
        } else {
            // No meta yet — the app itself must be owned before we create one.
            const owns = await client.query(
                `SELECT 1 FROM studio_apps WHERE id = $1 AND user_id = $2`, [appId, ownerId]
            );
            if (owns.rows.length === 0) {
                await client.query('ROLLBACK');
                return { ok: false, notFound: true };
            }
            currentModel = emptyDataModel();
            currentVersion = 0;
            metaExists = false;
        }

        // The app's stage, if any: only a deploy changes a stage's model.
        const app = await client.query(`SELECT project_id FROM studio_apps WHERE id = $1`, [appId]);
        const lock = await (io.managedParts || require('../managedPartsDefault')).assertManagedWrite({
            kind: 'app', projectId: app.rows[0] ? app.rows[0].project_id ?? null : null,
            changedKeys: ['dataModel'], managedWrite, client,
        });

        if (expectedVersion != null && currentVersion !== expectedVersion) {
            await client.query('ROLLBACK');
            return { ok: false, conflict: true, currentVersion, model: currentModel };
        }

        // A stage's model never loses a table or a column, whoever asks.
        const stage = additiveOnly || (lock.managed && lock.via === 'capability');
        if (stage) {
            const additive = additiveModel(currentModel, model);
            if (additive.invalid) {
                await client.query('ROLLBACK');
                return { ok: false, invalid: true, errors: additive.invalid };
            }
            if (additive.refused.length) {
                throw storeError(409, 'app.data_model_not_additive',
                    'This data model change is not additive: a stage only takes new tables, new optional columns and new indexes.',
                    { statements: additive.refused.slice(0, 20) });
            }
            model = additive.model;
        }

        // Apply the physical schema diff BEFORE persisting the new model.
        //
        // Under SQLITE the two stores are separate systems, so the DDL lands
        // first and targetVersion stamps PRAGMA user_version in the same SQLite
        // txn — the reconcile anchor for a PG COMMIT failing after this
        // succeeded (the documented split-brain window).
        //
        // Under POSTGRES the app's tables live in a schema inside THIS
        // database, and PG's DDL is transactional: passing our own client makes
        // the schema change and the model row ONE commit. Either both land or
        // neither does, so the drift window — and everything built to detect
        // and repair it — simply does not exist.
        const nextVersion = currentVersion + 1;
        const planned = planMigration(currentModel, model, stage ? {} : { convertTypes, onUnconvertible });
        const applied = await applyPlanned(io, { ownerId, appId, client, planned, nextVersion });
        // A refusal leaves through the catch below, which owns the ROLLBACK.
        if ('result' in applied) throw Object.assign(new Error('data model change refused'), { saveResult: applied.result });
        const payload = JSON.stringify(model ?? {});
        if (metaExists) {
            await client.query(
                `UPDATE studio_app_data_meta SET model = $1::jsonb, model_version = $2, updated_at = NOW()
                 WHERE app_id = $3 AND owner_user_id = $4`,
                [payload, nextVersion, appId, ownerId]
            );
        } else {
            await client.query(
                `INSERT INTO studio_app_data_meta (app_id, owner_user_id, model, model_version)
                 VALUES ($1, $2, $3::jsonb, $4)`,
                [appId, ownerId, payload, nextVersion]
            );
        }
        // Mirror the version onto studio_apps so an app-list read can tell an
        // app has a data model without a join.
        await client.query(
            `UPDATE studio_apps SET data_model_version = $1, updated_at = NOW() WHERE id = $2 AND user_id = $3`,
            [nextVersion, appId, ownerId]
        );
        await client.query('COMMIT');
        // Row counts can drift across a migration (table drops/recreates) —
        // take an authoritative recount, best-effort (the save is committed).
        try { await io.recountRows(appId, ownerId, Array.isArray(model && model.tables) ? model.tables : []); } catch (err) { bestEffort('stores/studioAppData/dataModel:saveDataModelIn', err); /* advisory */ }
        const report = buildMigrationReport(planned, applied.probed);
        await bumpTouchedTables(io, appId, ownerId, planned);
        return { ok: true, version: nextVersion, report };
    } catch (e) {
        await client.query('ROLLBACK').catch((e) => bestEffort('stores/studioAppData/dataModel:saveDataModelIn#2', e));
        const refusal = /** @type {{ saveResult?: import('./migrationPreview.mts').SaveRefusal }} */ (e).saveResult;
        if (refusal) return refusal;
        throw e;
    } finally {
        client.release();
    }
}

/** bumpDataVersion for every table whose rows a recompute or conversion changed (best-effort). */
async function bumpTouchedTables(io, appId, ownerId, planned) {
    const keys = new Set(planned.ops.filter((o) => o.kind !== 'unsupported').map((o) => o.tableKey));
    for (const key of keys) {
        try { await (io.bumpDataVersion || bumpDataVersion)(appId, key, ownerId); } catch (err) { bestEffort('stores/studioAppData/dataModel:bumpTouchedTables', err); }
    }
}

/**
 * The dry run of saveDataModel with the type conversions on: what it would do
 * to the rows (migrationPreview.previewAgainst), nothing written.
 * @param {string} appId
 * @param {string} ownerId
 * @param {Record<string, unknown>} model
 * @param {{ onUnconvertible?: 'refuse'|'clear' }} [opts]
 */
async function previewDataModelChange(appId, ownerId, model, opts = {}) {
    const meta = await getDataModel(appId, ownerId);
    return previewAgainst(appId, ownerId, model, meta, opts);
}

/**
 * The additive form of `model` against `current` (design 2, App row): every
 * table and field of `current` that `model` leaves out is RETAINED, so no
 * DROP is planned, and the plan from `current` to that model may hold only
 * new tables (CREATE TABLE with its own indexes), nullable ADD COLUMNs and
 * non-unique indexes. Anything else (a rename, a DROP, a unique index on an
 * existing table, a NOT NULL column) is listed in `refused`.
 *
 * Pure. `invalid` is the validator's errors when the merged model is not a
 * valid model (a new field reusing a retained field's key).
 *
 * @returns {{ model: DataModel, plan: string[], refused: string[], invalid: string[]|null }}
 */
function additiveModel(current, model) {
    const merged = retainRemoved(current, model);
    const { errors } = validateDataModel(merged);
    if (errors.length) return { model: merged, plan: [], refused: [], invalid: errors };
    const plan = migrationPlan(current, merged);
    return { model: merged, plan, refused: plan.filter((stmt) => !isAdditiveStatement(stmt)), invalid: null };
}

/** `model` plus every table and field of `current` it leaves out (matched by stable id). */
function retainRemoved(current, model) {
    const cur = Array.isArray(current && current.tables) ? current.tables : [];
    const next = Array.isArray(model && model.tables) ? model.tables : [];
    const nextById = new Map(next.filter((t) => t && t.id).map((t) => [t.id, t]));
    const tables = next.map((t) => {
        const old = cur.find((o) => o && o.id === t.id);
        if (!old || !Array.isArray(old.fields)) return t;
        const fields = Array.isArray(t.fields) ? t.fields : [];
        const ids = new Set(fields.map((f) => f && f.id));
        const kept = old.fields.filter((f) => f && f.id && !ids.has(f.id));
        return kept.length ? { ...t, fields: [...fields, ...kept] } : t;
    });
    for (const old of cur) if (old && old.id && !nextById.has(old.id)) tables.push(old);
    return { ...(model || {}), tables };
}

/** One plan entry an older release keeps working on: a new table, a nullable column, a plain index. */
function isAdditiveStatement(stmt) {
    const s = String(stmt).trim();
    if (/^CREATE TABLE IF NOT EXISTS\s/i.test(s)) return true;
    if (/^CREATE INDEX IF NOT EXISTS\s/i.test(s)) return true;
    if (/^ALTER TABLE\s+"(?:[^"]|"")*"\s+ADD COLUMN\s/i.test(s)) return !/\bNOT NULL\b/i.test(s);
    return false;
}

/**
 * saveDataModel over its collaborators: the store's own (db.js, the per-app
 * engine) for the app, a test's own for a pglite test of the lock.
 *
 * @param {{ getClient: () => Promise<any>, ready?: () => Promise<unknown>,
 *           applyMigration: Function, isPg: () => boolean, recountRows: Function,
 *           managedParts?: { assertManagedWrite: Function }|null }} io
 */
function makeDataModelSaver(io) {
    const ctx = { ready: async () => {}, managedParts: null, ...io };
    return {
        saveDataModel: (appId, ownerId, model, opts) => saveDataModelIn(ctx, appId, ownerId, model, opts),
    };
}

// The app's: wrapped rather than bound, so a test that replaces '../db' or
// './studioAppDbStore' before requiring this store is still honoured.
const { saveDataModel } = makeDataModelSaver({
    getClient: () => getClient(),
    ready: () => initDB(),
    applyMigration: (...a) => deps.studioAppDbStore.applyMigration(...a),
    isPg: () => isPg(),
    recountRows: (...a) => recountRows(...a),
});

module.exports = {
    getDataModel,
    saveDataModel,
    previewDataModelChange,
    makeDataModelSaver,
    additiveModel,
    reconcileDataModel,
};

/**
 * @typedef {{ id?: string, [key: string]: unknown }} DataModelField
 * @typedef {{ id?: string, key?: string, fields?: DataModelField[], [key: string]: unknown }} DataModelTable
 * @typedef {{ tables?: DataModelTable[], [key: string]: unknown }} DataModel
 */

/**
 * What saveDataModel answers (see saveDataModelIn).
 * @typedef {{ ok: boolean, version?: number, report?: import('./migrationPreview.mts').MigrationReport,
 *   invalid?: boolean, errors?: string[], conflict?: boolean, currentVersion?: number, model?: DataModel,
 *   notFound?: boolean, conversionRefused?: boolean, conversions?: import('./migrationPreview.mts').ConvertEntry[],
 *   migrationFailed?: boolean, failure?: import('./migrationPreview.mts').MigrationFailure }} SaveDataModelResult
 */

/**
 * The collaborators saveDataModelIn works over.
 * @typedef {{
 *   getClient: () => Promise<import('pg').PoolClient>,
 *   ready?: () => Promise<unknown>,
 *   applyMigration: (ownerId: string, appId: string, plan: string[], opts: { targetVersion: number, client?: import('pg').PoolClient }) => Promise<unknown>,
 *   isPg: () => boolean,
 *   recountRows: typeof recountRows,
 *   managedParts?: ReturnType<typeof import('../lib/managedParts').makeManagedParts> | null,
 * }} DataModelIo
 */
