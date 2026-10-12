// @typecheck
/**
 * Studio App Data Store — PostgreSQL metadata for the App Studio v2 DATA
 * ENGINE. Sits between the per-app SQLite engine (studioAppDbStore.js) and the
 * data-model contract (../appStudio/dataModel.js).
 *
 * Where studioAppDbStore owns the *rows* (in per-app SQLite), THIS store owns
 * the *metadata about the data*: the versioned data model, per-table data
 * versions + row counts (cache-invalidation tokens), saved datasets and their
 * cached results, app membership/roles, and the attachment ledger.
 *
 * Tables (all self-init: CREATE TABLE IF NOT EXISTS + additive ALTER loop):
 *   • studio_app_data_meta      — one row per app: the data model (JSONB) +
 *                                 optimistic model_version, data_versions,
 *                                 row_counts. saveDataModel diffs old→new via
 *                                 dataModel.migrationPlan and pushes the DDL
 *                                 through studioAppDbStore.applyMigration.
 *   • studio_app_datasets       — named, reusable query descriptors over a
 *                                 table (source + descriptor + cache TTL).
 *   • studio_app_dataset_cache  — memoised dataset results keyed by
 *                                 viewer_scope_key + params_hash + data_version.
 *   • studio_app_members        — app_id + user_id → role_key (RLS input).
 *   • studio_app_attachments    — file attachment ledger (mirrors
 *                                 webpage_extra_files) with scan/quarantine.
 *
 * OWNERSHIP: every mutation is owner-scoped in its WHERE — either directly via
 * an owner_user_id column, or (for the ownerless studio_app_members PK) via an
 * ownsApp() gate against studio_apps. A foreign app id can never be written
 * through. See studioAppDataStore.idor.test.js.
 */

const crypto = require('crypto');
const { run, getOne, getAll, exec, getClient } = require('../db');
const { makeStoreInit } = require('./lib/storeInit');
const { runDdl } = require('./lib/_ddl');
const { migrationPlan, validateDataModel, emptyDataModel } = require('../appStudio/dataModel');
const queryCompiler = require('../appStudio/queryCompiler');
const studioAppDbStore = require('./studioAppDbStore');
const studioAppStore = require('./studioAppStore');
const { isPg } = require('../utils/engineFlag');
const log = require('../telemetry/log');
const { parseJSON } = require('./lib/json');
const { buildUpdate } = require('./lib/sqlBuilder');
const { storeError } = require('./lib/managedParts');

const initDB = makeStoreInit('StudioAppDataStore', _initDB);

async function _initDB() {
    // FK dependants: studio_apps must exist first (mirrors webpagePublicShareStore
    // waiting on webpages). studioAppStore self-inits on load; await its handle.
    try { if (studioAppStore && studioAppStore.ready) await studioAppStore.ready; } catch (_) { /* proceed — FK create will surface a real problem */ }

    await exec(`
        CREATE TABLE IF NOT EXISTS studio_app_data_meta (
            app_id TEXT PRIMARY KEY REFERENCES studio_apps(id) ON DELETE CASCADE,
            owner_user_id TEXT NOT NULL,
            model JSONB NOT NULL DEFAULT '{}'::jsonb,
            model_version INTEGER NOT NULL DEFAULT 0,
            data_versions JSONB NOT NULL DEFAULT '{}'::jsonb,
            row_counts JSONB NOT NULL DEFAULT '{}'::jsonb,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_studio_app_data_meta_owner ON studio_app_data_meta(owner_user_id);
    `);

    await exec(`
        CREATE TABLE IF NOT EXISTS studio_app_datasets (
            id TEXT PRIMARY KEY,
            app_id TEXT NOT NULL REFERENCES studio_apps(id) ON DELETE CASCADE,
            owner_user_id TEXT NOT NULL,
            name TEXT NOT NULL DEFAULT 'Untitled dataset',
            table_id TEXT,
            source JSONB NOT NULL DEFAULT '{}'::jsonb,
            descriptor JSONB NOT NULL DEFAULT '{}'::jsonb,
            cache_ttl_seconds INTEGER NOT NULL DEFAULT 60,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_studio_app_datasets_app ON studio_app_datasets(app_id);
        CREATE INDEX IF NOT EXISTS idx_studio_app_datasets_owner ON studio_app_datasets(owner_user_id);
    `);

    await exec(`
        CREATE TABLE IF NOT EXISTS studio_app_dataset_cache (
            id TEXT PRIMARY KEY,
            dataset_id TEXT NOT NULL REFERENCES studio_app_datasets(id) ON DELETE CASCADE,
            viewer_scope_key TEXT NOT NULL,
            params_hash TEXT NOT NULL,
            data_version INTEGER NOT NULL DEFAULT 0,
            result JSONB NOT NULL DEFAULT '{}'::jsonb,
            row_count INTEGER NOT NULL DEFAULT 0,
            computed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            expires_at TIMESTAMPTZ
        );
        CREATE UNIQUE INDEX IF NOT EXISTS uq_studio_app_dataset_cache_key
            ON studio_app_dataset_cache(dataset_id, viewer_scope_key, params_hash);
    `);

    await exec(`
        CREATE TABLE IF NOT EXISTS studio_app_members (
            app_id TEXT NOT NULL REFERENCES studio_apps(id) ON DELETE CASCADE,
            user_id TEXT NOT NULL,
            role_key TEXT NOT NULL DEFAULT 'member',
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            PRIMARY KEY (app_id, user_id)
        );
    `);

    await exec(`
        CREATE TABLE IF NOT EXISTS studio_app_attachments (
            id TEXT PRIMARY KEY,
            app_id TEXT NOT NULL REFERENCES studio_apps(id) ON DELETE CASCADE,
            owner_user_id TEXT NOT NULL,
            record_id TEXT,
            field_key TEXT,
            mime_type TEXT NOT NULL DEFAULT 'application/octet-stream',
            sha256 TEXT NOT NULL DEFAULT '',
            size BIGINT NOT NULL DEFAULT 0,
            scanned BOOLEAN NOT NULL DEFAULT FALSE,
            quarantined BOOLEAN NOT NULL DEFAULT FALSE,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_studio_app_attachments_app ON studio_app_attachments(app_id);
        CREATE INDEX IF NOT EXISTS idx_studio_app_attachments_record ON studio_app_attachments(app_id, record_id);
    `);

    // Connector → table sync state. Deliberately NOT part of the data model
    // JSONB: writing last_run_at/watermark there on every refresh would churn
    // model_version under an editor that has the model open, and make every
    // background sync a potential save conflict.
    await exec(`
        CREATE TABLE IF NOT EXISTS studio_app_connector_sync (
            app_id TEXT NOT NULL REFERENCES studio_apps(id) ON DELETE CASCADE,
            connector_id TEXT NOT NULL,
            owner_user_id TEXT NOT NULL,
            table_key TEXT,
            status TEXT NOT NULL DEFAULT 'idle',
            last_run_at TIMESTAMPTZ,
            next_run_at TIMESTAMPTZ,
            started_at TIMESTAMPTZ,
            watermark TEXT,
            rows_written INTEGER NOT NULL DEFAULT 0,
            last_error TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            PRIMARY KEY (app_id, connector_id)
        );
        CREATE INDEX IF NOT EXISTS idx_studio_app_connector_sync_due
            ON studio_app_connector_sync(next_run_at) WHERE next_run_at IS NOT NULL;
    `);

    // Outbound e-mail ledger. An app that can send mail from a real person's
    // mailbox needs a record of what left and on whose authority — with a lend
    // grant the sender and the mailbox owner are different people, so both are
    // stored. Recipients are masked: this proves what happened without becoming
    // a second copy of the customer's address book.
    await exec(`
        CREATE TABLE IF NOT EXISTS studio_app_email_log (
            id BIGSERIAL PRIMARY KEY,
            app_id TEXT NOT NULL REFERENCES studio_apps(id) ON DELETE CASCADE,
            connector_id TEXT NOT NULL,
            viewer_user_id TEXT,
            effective_user_id TEXT,
            to_masked TEXT,
            subject TEXT,
            provider_message_id TEXT,
            thread_key TEXT,
            dlp_outcome TEXT,
            sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_studio_app_email_log_app ON studio_app_email_log(app_id, sent_at DESC);
    `);

    // Additive migrations — CREATE TABLE IF NOT EXISTS won't add columns to a
    // pre-existing table. Via runDdl (stores/lib/_ddl.js): fouten per statement
    // luid in de failures-lijst, de rest draait door — de oude catch (_) las
    // ook een timeout als "column already exists".
    await runDdl('studioAppDataStore', [
        `ALTER TABLE studio_app_data_meta ADD COLUMN IF NOT EXISTS data_versions JSONB NOT NULL DEFAULT '{}'::jsonb`,
        `ALTER TABLE studio_app_data_meta ADD COLUMN IF NOT EXISTS row_counts JSONB NOT NULL DEFAULT '{}'::jsonb`,
        `ALTER TABLE studio_app_datasets ADD COLUMN IF NOT EXISTS table_id TEXT`,
        `ALTER TABLE studio_app_datasets ADD COLUMN IF NOT EXISTS descriptor JSONB NOT NULL DEFAULT '{}'::jsonb`,
        `ALTER TABLE studio_app_datasets ADD COLUMN IF NOT EXISTS cache_ttl_seconds INTEGER NOT NULL DEFAULT 60`,
        `ALTER TABLE studio_app_attachments ADD COLUMN IF NOT EXISTS scanned BOOLEAN NOT NULL DEFAULT FALSE`,
        `ALTER TABLE studio_app_attachments ADD COLUMN IF NOT EXISTS quarantined BOOLEAN NOT NULL DEFAULT FALSE`,
        // Drives the exponential back-off in connectorSync. Without a streak
        // counter, a failing connector reschedules at its normal cadence
        // forever — which for a 2-minute mailbox means hammering a provider
        // that is already throttling us.
        `ALTER TABLE studio_app_connector_sync ADD COLUMN IF NOT EXISTS consecutive_errors INTEGER NOT NULL DEFAULT 0`,
    ]);
    log.info('[StudioAppDataStore] PostgreSQL initialized');
}

// ── Helpers ─────────────────────────────────────────────────────────


function toIso(v) { return v ? new Date(v).toISOString() : null; }

/** Ownership gate for the ownerless studio_app_members PK. */
async function ownsApp(appId, ownerId) {
    if (!appId || !ownerId) return false;
    const r = await getOne(`SELECT 1 FROM studio_apps WHERE id = $1 AND user_id = $2`, [appId, ownerId]);
    return !!r;
}

// ── Row mappers ─────────────────────────────────────────────────────

function mapMetaRow(r) {
    return {
        appId: r.app_id,
        ownerUserId: r.owner_user_id,
        model: parseJSON(r.model, {}),
        modelVersion: parseInt(r.model_version) || 0,
        dataVersions: parseJSON(r.data_versions, {}),
        rowCounts: parseJSON(r.row_counts, {}),
        createdAt: toIso(r.created_at),
        updatedAt: toIso(r.updated_at),
    };
}

function mapDatasetRow(r) {
    return {
        id: r.id,
        appId: r.app_id,
        ownerUserId: r.owner_user_id,
        name: r.name,
        tableId: r.table_id || null,
        source: parseJSON(r.source, {}),
        descriptor: parseJSON(r.descriptor, {}),
        cacheTtlSeconds: parseInt(r.cache_ttl_seconds) || 0,
        createdAt: toIso(r.created_at),
        updatedAt: toIso(r.updated_at),
    };
}

function mapCacheRow(r) {
    return {
        id: r.id,
        datasetId: r.dataset_id,
        viewerScopeKey: r.viewer_scope_key,
        paramsHash: r.params_hash,
        dataVersion: parseInt(r.data_version) || 0,
        result: parseJSON(r.result, {}),
        rowCount: parseInt(r.row_count) || 0,
        computedAt: toIso(r.computed_at),
        expiresAt: toIso(r.expires_at),
    };
}

function mapMemberRow(r) {
    return { appId: r.app_id, userId: r.user_id, roleKey: r.role_key, createdAt: toIso(r.created_at) };
}

function mapAttachmentRow(r) {
    return {
        id: r.id,
        appId: r.app_id,
        ownerUserId: r.owner_user_id,
        recordId: r.record_id || null,
        fieldKey: r.field_key || null,
        mimeType: r.mime_type,
        sha256: r.sha256 || '',
        size: parseInt(r.size) || 0,
        scanned: r.scanned === true || r.scanned === 't',
        quarantined: r.quarantined === true || r.quarantined === 't',
        createdAt: toIso(r.created_at),
        updatedAt: toIso(r.updated_at),
    };
}

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
            log.warn(`[StudioAppDataStore] reconcile failed for ${appId}: ${e.message}`);
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
        sqliteVersion = await studioAppDbStore.getSchemaStamp(ownerId, appId);
    } catch (e) {
        log.warn(`[StudioAppDataStore] reconcile: user_version read failed for ${appId}: ${e.message}`);
        return { ok: false, error: e.message };
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
            log.warn(`[StudioAppDataStore] reconcile recount failed for ${appId}: ${e.message}`);
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
 * Returns:
 *   { ok:true, version }                                   on success
 *   { ok:false, invalid:true, errors }                     model failed validation
 *   { ok:false, conflict:true, currentVersion, model }     expectedVersion mismatch
 *   { ok:false, notFound:true }                            app not owned / missing
 */
async function saveDataModelIn(io, appId, ownerId, model, { expectedVersion = null, managedWrite = null, additiveOnly = false } = {}) {
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
        let currentVersion;
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
        const lock = await (io.managedParts || require('./lib/managedParts')).assertManagedWrite({
            kind: 'app', projectId: app.rows[0] ? app.rows[0].project_id ?? null : null,
            changedKeys: ['dataModel'], managedWrite, client,
        });

        if (expectedVersion != null && currentVersion !== expectedVersion) {
            await client.query('ROLLBACK');
            return { ok: false, conflict: true, currentVersion, model: currentModel };
        }

        // A stage's model never loses a table or a column, whoever asks.
        if (additiveOnly || (lock.managed && lock.via === 'capability')) {
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
        const plan = migrationPlan(currentModel, model);
        await io.applyMigration(ownerId, appId, plan, {
            targetVersion: nextVersion,
            ...(io.isPg() ? { client } : {}),
        });
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
        try { await io.recountRows(appId, ownerId, Array.isArray(model && model.tables) ? model.tables : []); } catch (_) { /* advisory */ }
        return { ok: true, version: nextVersion };
    } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        throw e;
    } finally {
        client.release();
    }
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
 * @returns {{ model: object, plan: string[], refused: string[], invalid: object[]|null }}
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
    applyMigration: (...a) => studioAppDbStore.applyMigration(...a),
    isPg: () => isPg(),
    recountRows: (...a) => recountRows(...a),
});

/**
 * Bump a table's data version (a monotonically-increasing cache-invalidation
 * token). Read-modify-write of the whole data_versions JSONB under a row lock
 * so we don't depend on jsonb_set. Owner-scoped. Returns the new value, or null
 * when the app isn't owned / has no meta row yet.
 */
async function bumpDataVersion(appId, tableKey, ownerId) {
    await initDB();
    const client = await getClient();
    try {
        await client.query('BEGIN');
        const cur = await client.query(
            `SELECT data_versions FROM studio_app_data_meta WHERE app_id = $1 AND owner_user_id = $2 FOR UPDATE`,
            [appId, ownerId]
        );
        if (cur.rows.length === 0) { await client.query('ROLLBACK'); return null; }
        const versions = parseJSON(cur.rows[0].data_versions, {});
        const next = (parseInt(versions[tableKey]) || 0) + 1;
        versions[tableKey] = next;
        await client.query(
            `UPDATE studio_app_data_meta SET data_versions = $1::jsonb, updated_at = NOW()
             WHERE app_id = $2 AND owner_user_id = $3`,
            [JSON.stringify(versions), appId, ownerId]
        );
        await client.query('COMMIT');
        return next;
    } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        throw e;
    } finally {
        client.release();
    }
}

/** row_counts map for the app (owner-scoped). {} when no meta row. */
async function getRowCounts(appId, ownerId) {
    await initDB();
    const r = await getOne(
        `SELECT row_counts FROM studio_app_data_meta WHERE app_id = $1 AND owner_user_id = $2`,
        [appId, ownerId]
    );
    return r ? parseJSON(r.row_counts, {}) : {};
}

// Shared FOR-UPDATE read-modify-write over the row_counts JSONB (the ONE place
// that locks it — setRowCount / bumpRowCount / recountRows all go through here).
// `mutate` receives the parsed counts map and edits it in place. Returns the
// full map, or null when the app isn't owned / has no meta row yet.
async function withRowCounts(appId, ownerId, mutate) {
    await initDB();
    const client = await getClient();
    try {
        await client.query('BEGIN');
        const cur = await client.query(
            `SELECT row_counts FROM studio_app_data_meta WHERE app_id = $1 AND owner_user_id = $2 FOR UPDATE`,
            [appId, ownerId]
        );
        if (cur.rows.length === 0) { await client.query('ROLLBACK'); return null; }
        const counts = parseJSON(cur.rows[0].row_counts, {});
        mutate(counts);
        await client.query(
            `UPDATE studio_app_data_meta SET row_counts = $1::jsonb, updated_at = NOW()
             WHERE app_id = $2 AND owner_user_id = $3`,
            [JSON.stringify(counts), appId, ownerId]
        );
        await client.query('COMMIT');
        return counts;
    } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        throw e;
    } finally {
        client.release();
    }
}

/** Set one table's row count (owner-scoped). Returns the full map, or null. */
async function setRowCount(appId, tableKey, count, ownerId) {
    return withRowCounts(appId, ownerId, (counts) => {
        counts[tableKey] = Math.max(0, parseInt(count) || 0);
    });
}

/**
 * Delta-bump one table's cached row count (+1 create, -1 delete), clamped ≥ 0.
 * Same lock as setRowCount. Returns the full map, or null when not owned.
 */
async function bumpRowCount(appId, tableKey, delta, ownerId) {
    const d = parseInt(delta, 10) || 0;
    return withRowCounts(appId, ownerId, (counts) => {
        counts[tableKey] = Math.max(0, (parseInt(counts[tableKey], 10) || 0) + d);
    });
}

/**
 * Authoritative recount: COUNT(*) every given model table in the per-app
 * SQLite DB (owner-scoped) and REWRITE row_counts wholesale — dropped tables
 * fall out of the map. Called best-effort after a successful saveDataModel;
 * a table whose physical relation is missing counts as 0. Returns the new
 * map, or null when the app isn't owned.
 */
async function recountRows(appId, ownerId, tables) {
    await initDB();
    const fresh = {};
    for (const t of (Array.isArray(tables) ? tables : [])) {
        if (!t || typeof t.key !== 'string' || !t.key) continue;
        try {
            const { sql, params } = queryCompiler.compileAggregate(
                t, { aggregates: [{ fn: 'count', as: 'n' }] }, { where: '1=1', params: [] }
            );
            const { rows } = await studioAppDbStore.query(ownerId, appId, sql, params);
            fresh[t.key] = rows && rows[0] ? Math.max(0, parseInt(rows[0].n, 10) || 0) : 0;
        } catch (_) {
            fresh[t.key] = 0; // physical table missing/mid-migration — authoritative 0
        }
    }
    return withRowCounts(appId, ownerId, (counts) => {
        for (const k of Object.keys(counts)) delete counts[k];
        Object.assign(counts, fresh);
    });
}

// ── Datasets ────────────────────────────────────────────────────────

/**
 * @param appId
 * @param ownerId
 * @param {{ name?: string, tableId?: string, source?: string, descriptor?: any, cacheTtlSeconds?: number }} [opts]
 */
async function createDataset(appId, ownerId, { name, tableId, source, descriptor, cacheTtlSeconds } = {}) {
    await initDB();
    if (!appId || !ownerId) throw new Error('appId and ownerId required');
    const id = crypto.randomUUID();
    const row = await getOne(
        `INSERT INTO studio_app_datasets (id, app_id, owner_user_id, name, table_id, source, descriptor, cache_ttl_seconds)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8) RETURNING *`,
        [id, appId, ownerId, name || 'Untitled dataset', tableId || null,
         JSON.stringify(source || {}), JSON.stringify(descriptor || {}),
         Number.isFinite(cacheTtlSeconds) ? cacheTtlSeconds : 60]
    );
    return mapDatasetRow(row);
}

async function listDatasets(appId, ownerId) {
    await initDB();
    const rows = await getAll(
        `SELECT * FROM studio_app_datasets WHERE app_id = $1 AND owner_user_id = $2 ORDER BY updated_at DESC`,
        [appId, ownerId]
    );
    return rows.map(mapDatasetRow);
}

async function getDataset(id, appId, ownerId) {
    await initDB();
    const r = await getOne(
        `SELECT * FROM studio_app_datasets WHERE id = $1 AND app_id = $2 AND owner_user_id = $3`,
        [id, appId, ownerId]
    );
    return r ? mapDatasetRow(r) : null;
}

const DATASET_COLUMNS = {
    name: 'name',
    tableId: { col: 'table_id', transform: (v) => v || null },
    source: { col: 'source', cast: 'jsonb', transform: (v) => JSON.stringify(v || {}) },
    descriptor: { col: 'descriptor', cast: 'jsonb', transform: (v) => JSON.stringify(v || {}) },
    cacheTtlSeconds: { col: 'cache_ttl_seconds', transform: (v) => (Number.isFinite(v) ? v : 60) },
};

async function updateDataset(id, appId, ownerId, updates = {}) {
    await initDB();
    const built = buildUpdate({
        table: 'studio_app_datasets',
        updates,
        columnMap: DATASET_COLUMNS,
        extraSet: ['updated_at = NOW()'],
        where: [{ col: 'id', value: id }, { col: 'app_id', value: appId }, { col: 'owner_user_id', value: ownerId }],
        returning: '*',
    });
    if (!built) return getDataset(id, appId, ownerId);
    const row = await getOne(built.sql, built.params);
    return row ? mapDatasetRow(row) : null;
}

async function deleteDataset(id, appId, ownerId) {
    await initDB();
    const r = await getOne(
        `SELECT id FROM studio_app_datasets WHERE id = $1 AND app_id = $2 AND owner_user_id = $3`,
        [id, appId, ownerId]
    );
    if (!r) return false;
    // Cache rows FK-cascade on dataset delete, but clear explicitly too so the
    // behaviour holds even where the FK isn't enforced.
    await run(`DELETE FROM studio_app_dataset_cache WHERE dataset_id = $1`, [id]);
    await run(`DELETE FROM studio_app_datasets WHERE id = $1 AND app_id = $2 AND owner_user_id = $3`, [id, appId, ownerId]);
    return true;
}

// ── Dataset cache ───────────────────────────────────────────────────
//
// Reached only through an owner-scoped dataset (getDataset gates ownership);
// the cache itself keys on the opaque dataset_id (a uuid) plus the viewer's
// scope key, the params hash, and the table's data_version. A hit is only
// returned when the data_version still matches AND the row hasn't expired.

async function getCache(datasetId, viewerScopeKey, paramsHash, dataVersion) {
    await initDB();
    const r = await getOne(
        `SELECT * FROM studio_app_dataset_cache
         WHERE dataset_id = $1 AND viewer_scope_key = $2 AND params_hash = $3 AND data_version = $4`,
        [datasetId, viewerScopeKey, paramsHash, parseInt(dataVersion) || 0]
    );
    if (!r) return null;
    // Expiry filtered in JS so the query stays within the simple equality shape.
    if (r.expires_at && new Date(r.expires_at).getTime() <= Date.now()) return null;
    return mapCacheRow(r);
}

/**
 * @param datasetId
 * @param {{ viewerScopeKey?: string, paramsHash?: string, dataVersion?: string|number, result?: any, rowCount?: number, ttlSeconds?: number }} [opts]
 */
async function putCache(datasetId, { viewerScopeKey, paramsHash, dataVersion, result, rowCount, ttlSeconds } = {}) {
    await initDB();
    const id = crypto.randomUUID();
    const ttl = Number.isFinite(ttlSeconds) ? ttlSeconds : 60;
    const expiresAt = new Date(Date.now() + ttl * 1000).toISOString();
    const client = await getClient();
    try {
        await client.query('BEGIN');
        // Replace any existing entry for this (dataset, viewer, params) tuple.
        await client.query(
            `DELETE FROM studio_app_dataset_cache
             WHERE dataset_id = $1 AND viewer_scope_key = $2 AND params_hash = $3`,
            [datasetId, viewerScopeKey, paramsHash]
        );
        await client.query(
            `INSERT INTO studio_app_dataset_cache
                (id, dataset_id, viewer_scope_key, params_hash, data_version, result, row_count, expires_at)
             VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)`,
            [id, datasetId, viewerScopeKey, paramsHash, parseInt(dataVersion) || 0,
             JSON.stringify(result ?? {}), parseInt(rowCount) || 0, expiresAt]
        );
        await client.query('COMMIT');
        return { ok: true, id, expiresAt };
    } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        throw e;
    } finally {
        client.release();
    }
}

/** Drop all cached results for a dataset (e.g. after its descriptor changes). */
async function invalidateCache(datasetId) {
    await initDB();
    await run(`DELETE FROM studio_app_dataset_cache WHERE dataset_id = $1`, [datasetId]);
}

// ── Connector sync state ────────────────────────────────────────────
//
// One row per (app, connector) that materialises into a table. Holds the things
// a refresh needs to be INCREMENTAL and IDEMPOTENT across replicas: when it last
// ran, when it is next due, and the high-watermark reached so far.
//
// The claim is a conditional UPDATE rather than a read-then-write, so two
// replicas ticking at the same second cannot both start the same sync. A crashed
// run would otherwise hold `running` forever, so a claim older than
// SYNC_STALE_MS is reclaimable.

const SYNC_STALE_MS = 15 * 60 * 1000;

function mapSyncRow(r) {
    if (!r) return null;
    return {
        appId: r.app_id,
        connectorId: r.connector_id,
        ownerUserId: r.owner_user_id,
        tableKey: r.table_key || null,
        status: r.status || 'idle',
        lastRunAt: toIso(r.last_run_at),
        nextRunAt: toIso(r.next_run_at),
        startedAt: toIso(r.started_at),
        watermark: r.watermark || null,
        rowsWritten: parseInt(r.rows_written) || 0,
        lastError: r.last_error || null,
        consecutiveErrors: parseInt(r.consecutive_errors) || 0,
    };
}

async function getSyncState(appId, connectorId) {
    await initDB();
    const r = await getOne(
        `SELECT * FROM studio_app_connector_sync WHERE app_id = $1 AND connector_id = $2`,
        [appId, connectorId],
    );
    return mapSyncRow(r);
}

async function listSyncStates(appId) {
    await initDB();
    const rows = await getAll(
        `SELECT * FROM studio_app_connector_sync WHERE app_id = $1 ORDER BY connector_id`, [appId],
    );
    return (rows || []).map(mapSyncRow);
}

/**
 * Claim a sync for this process. Returns the claimed state, or null when another
 * replica (or an earlier tick in this one) already owns it. Creates the row on
 * first use, so a connector never needs an explicit "register" step.
 */
async function claimSync(appId, connectorId, ownerUserId, { tableKey = null } = {}) {
    await initDB();
    const staleBefore = new Date(Date.now() - SYNC_STALE_MS).toISOString();
    const r = await getOne(
        `INSERT INTO studio_app_connector_sync (app_id, connector_id, owner_user_id, table_key, status, started_at)
         VALUES ($1, $2, $3, $4, 'running', NOW())
         ON CONFLICT (app_id, connector_id) DO UPDATE
            SET status = 'running', started_at = NOW(), table_key = $4, updated_at = NOW()
          WHERE studio_app_connector_sync.status <> 'running'
             OR studio_app_connector_sync.started_at IS NULL
             OR studio_app_connector_sync.started_at < $5
         RETURNING *`,
        [appId, connectorId, ownerUserId, tableKey, staleBefore],
    );
    return mapSyncRow(r);
}

/**
 * Release a claim, recording the outcome and when the next run is due.
 * @param appId
 * @param connectorId
 * @param {{ status?: string, watermark?: any, rowsWritten?: number, nextRunAt?: string|Date, error?: string, consecutiveErrors?: number }} [opts]
 */
async function finishSync(appId, connectorId, { status, watermark, rowsWritten, nextRunAt, error, consecutiveErrors } = {}) {
    await initDB();
    // The streak counter is what lets the caller widen the retry gap. Passing
    // null keeps whatever is stored, so an older caller that doesn't know about
    // it can't accidentally reset a back-off.
    const streak = Number.isInteger(consecutiveErrors) ? consecutiveErrors : null;
    const r = await getOne(
        `UPDATE studio_app_connector_sync
            SET status = $3,
                last_run_at = NOW(),
                started_at = NULL,
                next_run_at = $4,
                watermark = COALESCE($5, watermark),
                rows_written = $6,
                last_error = $7,
                consecutive_errors = COALESCE($8, consecutive_errors),
                updated_at = NOW()
          WHERE app_id = $1 AND connector_id = $2
          RETURNING *`,
        [appId, connectorId, status === 'error' ? 'error' : 'ok',
         nextRunAt || null, watermark ?? null, parseInt(rowsWritten) || 0,
         error ? String(error).slice(0, 500) : null, streak],
    );
    return mapSyncRow(r);
}

/**
 * Syncs whose next_run_at has passed. The background job walks this; the LIMIT
 * bounds one tick so a backlog drains over several minutes instead of stalling
 * the tick (and every other job behind it).
 */
async function listDueSyncs(limit = 25) {
    await initDB();
    const rows = await getAll(
        `SELECT * FROM studio_app_connector_sync
          WHERE next_run_at IS NOT NULL AND next_run_at <= NOW()
            AND (status <> 'running' OR started_at IS NULL OR started_at < $2)
          ORDER BY next_run_at ASC
          LIMIT $1`,
        [Math.max(1, Math.min(200, parseInt(limit) || 25)), new Date(Date.now() - SYNC_STALE_MS).toISOString()],
    );
    return (rows || []).map(mapSyncRow);
}

/**
 * Append one outbound message to the ledger.
 * @param {{ appId?: string, connectorId?: string, viewerUserId?: string, effectiveUserId?: string, toMasked?: string, subject?: string, providerMessageId?: string, threadKey?: string, dlpOutcome?: string }} [opts]
 */
async function logEmailSend({
    appId, connectorId, viewerUserId, effectiveUserId,
    toMasked, subject, providerMessageId, threadKey, dlpOutcome,
} = {}) {
    await initDB();
    await run(
        `INSERT INTO studio_app_email_log
            (app_id, connector_id, viewer_user_id, effective_user_id, to_masked, subject, provider_message_id, thread_key, dlp_outcome)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [appId, connectorId, viewerUserId || null, effectiveUserId || null,
         toMasked || null, subject || null, providerMessageId || null, threadKey || null, dlpOutcome || null],
    );
}

/** The app's outbound history, newest first. */
async function listEmailSends(appId, { limit = 100 } = {}) {
    await initDB();
    const rows = await getAll(
        `SELECT * FROM studio_app_email_log WHERE app_id = $1 ORDER BY sent_at DESC LIMIT $2`,
        [appId, Math.max(1, Math.min(500, parseInt(limit) || 100))],
    );
    return (rows || []).map((r) => ({
        id: String(r.id),
        connectorId: r.connector_id,
        viewerUserId: r.viewer_user_id || null,
        effectiveUserId: r.effective_user_id || null,
        toMasked: r.to_masked || null,
        subject: r.subject || null,
        providerMessageId: r.provider_message_id || null,
        threadKey: r.thread_key || null,
        dlpOutcome: r.dlp_outcome || null,
        sentAt: toIso(r.sent_at),
    }));
}

/** Forget a connector's sync state (the connector or its table was removed). */
async function deleteSyncState(appId, connectorId) {
    await initDB();
    await run(`DELETE FROM studio_app_connector_sync WHERE app_id = $1 AND connector_id = $2`, [appId, connectorId]);
}

/**
 * Bring the sync rows in line with the model that was just saved.
 *
 * A connector that fills a table needs a row here before the background job can
 * ever see it — `listDueSyncs` selects on `next_run_at`, and until this ran the
 * ONLY thing that created a row was a sync actually starting. That is a deadlock:
 * a freshly configured schedule would never fire on its own, so the table stayed
 * empty until someone happened to open the app or press "Refresh now" — and
 * silently forever if they turned on-view refresh off.
 *
 * Seeding `next_run_at = NOW()` means saving the model IS the trigger for the
 * first fill; the job picks it up on its next tick (≤60s). Existing rows are left
 * alone so an in-flight run and its watermark survive a model edit.
 *
 * @param {string[]} syncedConnectorIds  ids of connectors that carry a sync block
 * @returns {Promise<{ seeded: string[], removed: number }>}
 */
async function reconcileSyncStates(appId, ownerId, syncedConnectorIds = []) {
    await initDB();
    const wanted = [...new Set((syncedConnectorIds || []).filter((id) => typeof id === 'string' && id))];

    // Drop rows for connectors that no longer fill a table.
    let removed = 0;
    if (wanted.length) {
        const res = await run(
            `DELETE FROM studio_app_connector_sync WHERE app_id = $1 AND NOT (connector_id = ANY($2::text[]))`,
            [appId, wanted],
        );
        removed = res?.rowCount || 0;
    } else {
        const res = await run(`DELETE FROM studio_app_connector_sync WHERE app_id = $1`, [appId]);
        removed = res?.rowCount || 0;
    }

    // Seed the ones we've never seen, due immediately.
    const seeded = [];
    for (const connectorId of wanted) {
        const row = await getOne(
            `INSERT INTO studio_app_connector_sync (app_id, connector_id, owner_user_id, status, next_run_at)
             VALUES ($1, $2, $3, 'idle', NOW())
             ON CONFLICT (app_id, connector_id) DO NOTHING
             RETURNING connector_id`,
            [appId, connectorId, ownerId],
        );
        if (row) seeded.push(row.connector_id);
    }
    return { seeded, removed };
}

// ── Members ─────────────────────────────────────────────────────────

/** Add or re-role a member. Owner-gated via ownsApp (the PK has no owner col). */
async function addMember(appId, ownerId, memberUserId, roleKey = 'member') {
    await initDB();
    if (!(await ownsApp(appId, ownerId))) return null;
    const existing = await getOne(
        `SELECT app_id FROM studio_app_members WHERE app_id = $1 AND user_id = $2`, [appId, memberUserId]
    );
    if (existing) {
        const row = await getOne(
            `UPDATE studio_app_members SET role_key = $1, updated_at = NOW()
             WHERE app_id = $2 AND user_id = $3 RETURNING *`,
            [roleKey || 'member', appId, memberUserId]
        );
        return row ? mapMemberRow(row) : null;
    }
    const row = await getOne(
        `INSERT INTO studio_app_members (app_id, user_id, role_key) VALUES ($1, $2, $3) RETURNING *`,
        [appId, memberUserId, roleKey || 'member']
    );
    return row ? mapMemberRow(row) : null;
}

/** Members of an app — owner-gated. */
async function listMembers(appId, ownerId) {
    await initDB();
    if (!(await ownsApp(appId, ownerId))) return [];
    const rows = await getAll(
        `SELECT * FROM studio_app_members WHERE app_id = $1 ORDER BY created_at ASC`, [appId]
    );
    return rows.map(mapMemberRow);
}

async function removeMember(appId, ownerId, memberUserId) {
    await initDB();
    if (!(await ownsApp(appId, ownerId))) return false;
    await run(`DELETE FROM studio_app_members WHERE app_id = $1 AND user_id = $2`, [appId, memberUserId]);
    return true;
}

/**
 * A viewer's own role in an app. Deliberately NOT owner-scoped — this is the
 * RLS gateway resolving the caller's own membership, not an owner mutating
 * someone else's. Returns the role_key or null.
 */
async function getMemberRole(appId, userId) {
    await initDB();
    const r = await getOne(
        `SELECT role_key FROM studio_app_members WHERE app_id = $1 AND user_id = $2`, [appId, userId]
    );
    return r ? r.role_key : null;
}

// ── Attachments ─────────────────────────────────────────────────────

/**
 * @param appId
 * @param ownerId
 * @param {{ recordId?: string, fieldKey?: string, mimeType?: string, sha256?: string, size?: number }} [opts]
 */
async function addAttachment(appId, ownerId, { recordId, fieldKey, mimeType, sha256, size } = {}) {
    await initDB();
    if (!appId || !ownerId) throw new Error('appId and ownerId required');
    const id = crypto.randomUUID();
    const row = await getOne(
        `INSERT INTO studio_app_attachments (id, app_id, owner_user_id, record_id, field_key, mime_type, sha256, size)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
        [id, appId, ownerId, recordId || null, fieldKey || null,
         mimeType || 'application/octet-stream', sha256 || '', Number.isFinite(size) ? size : 0]
    );
    return mapAttachmentRow(row);
}

/**
 * @param appId
 * @param ownerId
 * @param {{ recordId?: string }} [opts]
 */
async function listAttachments(appId, ownerId, { recordId } = {}) {
    await initDB();
    if (recordId !== undefined) {
        const rows = await getAll(
            `SELECT * FROM studio_app_attachments WHERE app_id = $1 AND owner_user_id = $2 AND record_id = $3 ORDER BY created_at DESC`,
            [appId, ownerId, recordId]
        );
        return rows.map(mapAttachmentRow);
    }
    const rows = await getAll(
        `SELECT * FROM studio_app_attachments WHERE app_id = $1 AND owner_user_id = $2 ORDER BY created_at DESC`,
        [appId, ownerId]
    );
    return rows.map(mapAttachmentRow);
}

async function getAttachment(id, appId, ownerId) {
    await initDB();
    const r = await getOne(
        `SELECT * FROM studio_app_attachments WHERE id = $1 AND app_id = $2 AND owner_user_id = $3`,
        [id, appId, ownerId]
    );
    return r ? mapAttachmentRow(r) : null;
}

const ATTACHMENT_SCAN_COLUMNS = {
    scanned: { col: 'scanned', transform: (v) => !!v },
    quarantined: { col: 'quarantined', transform: (v) => !!v },
};

/**
 * Record scan/quarantine outcome for an attachment (owner-scoped).
 * @param id
 * @param appId
 * @param ownerId
 * @param {{ scanned?: boolean, quarantined?: boolean }} [opts]
 */
async function setAttachmentScan(id, appId, ownerId, { scanned, quarantined } = {}) {
    await initDB();
    const built = buildUpdate({
        table: 'studio_app_attachments',
        updates: { scanned, quarantined },
        columnMap: ATTACHMENT_SCAN_COLUMNS,
        extraSet: ['updated_at = NOW()'],
        where: [{ col: 'id', value: id }, { col: 'app_id', value: appId }, { col: 'owner_user_id', value: ownerId }],
        returning: '*',
    });
    if (!built) return getAttachment(id, appId, ownerId);
    const row = await getOne(built.sql, built.params);
    return row ? mapAttachmentRow(row) : null;
}

async function deleteAttachment(id, appId, ownerId) {
    await initDB();
    const r = await getOne(
        `SELECT id FROM studio_app_attachments WHERE id = $1 AND app_id = $2 AND owner_user_id = $3`,
        [id, appId, ownerId]
    );
    if (!r) return false;
    await run(`DELETE FROM studio_app_attachments WHERE id = $1 AND app_id = $2 AND owner_user_id = $3`, [id, appId, ownerId]);
    return true;
}

/**
 * How many attachment rows still point at these bytes (owner-scoped).
 *
 * Blobs are content-addressed on sha256, so two ledger rows for identical bytes
 * share ONE object in the store. Deleting a row must therefore only delete the
 * object when it was the last row referencing it — otherwise removing a
 * duplicate pick silently breaks the record that kept its copy.
 */
async function countAttachmentsBySha(appId, ownerId, sha256) {
    await initDB();
    if (!sha256) return 0;
    const rows = await getAll(
        `SELECT id FROM studio_app_attachments WHERE app_id = $1 AND owner_user_id = $2 AND sha256 = $3`,
        [appId, ownerId, sha256]
    );
    return rows.length;
}

/** Count attachments for an app (owner-scoped) — enforces the per-app cap. */
async function countAttachments(appId, ownerId) {
    await initDB();
    const rows = await getAll(
        `SELECT id FROM studio_app_attachments WHERE app_id = $1 AND owner_user_id = $2`, [appId, ownerId]
    );
    return rows.length;
}

module.exports = {
    // Beide spellingen, zoals studioAppStore: `ready` awaiten is hetzelfde als
    // initDB() aanroepen, en requiren van deze module maakt nog niets aan.
    get ready() { return initDB(); },
    initDB,
    // Data model
    getDataModel,
    saveDataModel,
    makeDataModelSaver,
    additiveModel,
    reconcileDataModel,
    bumpDataVersion,
    getRowCounts,
    setRowCount,
    bumpRowCount,
    recountRows,
    // Datasets
    createDataset,
    listDatasets,
    getDataset,
    updateDataset,
    deleteDataset,
    // Dataset cache
    getCache,
    putCache,
    invalidateCache,
    // Connector sync state
    getSyncState,
    listSyncStates,
    claimSync,
    finishSync,
    listDueSyncs,
    deleteSyncState,
    reconcileSyncStates,
    SYNC_STALE_MS,
    // Outbound e-mail ledger
    logEmailSend,
    listEmailSends,
    // Members
    addMember,
    listMembers,
    removeMember,
    getMemberRole,
    // Attachments
    addAttachment,
    listAttachments,
    getAttachment,
    setAttachmentScan,
    deleteAttachment,
    countAttachments,
    countAttachmentsBySha,
};
