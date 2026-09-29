// @typecheck
/**
 * Platform Module Store — instance-level module import state.
 *
 * One row per module the operator EXPLICITLY imported or removed. Row-absent
 * means "catalog default" (server/modules/catalog.js defaultImported) — no
 * seeding on boot, so grandfathered modules stay active on existing installs
 * without a migration. The runtime join (catalog × rows) lives in
 * server/modules/index.js; this store is dumb persistence only.
 */

const { run, getOne, getAll, exec } = require('../db');
const { makeStoreInit } = require('./lib/storeInit');
const { runDdl } = require('./lib/_ddl');
const log = require('../telemetry/log');
const { parseJSONObject: parseJSON } = require('./lib/json');

const initDB = makeStoreInit('PlatformModuleStore', _initDB);

async function _initDB() {

    await exec(`
        CREATE TABLE IF NOT EXISTS platform_modules (
            module_id TEXT PRIMARY KEY,
            status TEXT NOT NULL CHECK (status IN ('imported','removed')),
            version TEXT,
            imported_at TIMESTAMPTZ,
            imported_by TEXT,
            removed_at TIMESTAMPTZ,
            removed_by TEXT,
            settings JSONB,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
    `);
    // Forward-compat: ensure newer columns exist on older deploys. All
    // statements are idempotent; via runDdl komt een échte fout luid in de
    // failures-lijst i.p.v. stil ingeslikt.
    await runDdl('platformModuleStore', [
        `ALTER TABLE platform_modules ADD COLUMN IF NOT EXISTS settings JSONB`,
    ]);
    log.info('[PlatformModuleStore] PostgreSQL initialized');
}


function mapRow(r) {
    if (!r) return null;
    return {
        moduleId: r.module_id,
        status: r.status,
        version: r.version || null,
        importedAt: r.imported_at ? new Date(r.imported_at).toISOString() : null,
        importedBy: r.imported_by || null,
        removedAt: r.removed_at ? new Date(r.removed_at).toISOString() : null,
        removedBy: r.removed_by || null,
        settings: parseJSON(r.settings, null),
        updatedAt: r.updated_at ? new Date(r.updated_at).toISOString() : null,
    };
}

async function getAllStates() {
    await initDB();
    const rows = await getAll(`SELECT * FROM platform_modules`);
    return rows.map(mapRow);
}

async function getState(moduleId) {
    await initDB();
    return mapRow(await getOne(`SELECT * FROM platform_modules WHERE module_id = $1`, [moduleId]));
}

async function setImported(moduleId, { actorId = null, version = null, settings = undefined } = {}) {
    await initDB();
    // `settings` is optional: built-in imports omit it (leaving the column
    // untouched on re-import), remote imports pass the { remote, manifest,
    // entitlement, package } descriptor. `undefined` ⇒ don't write the column;
    // an explicit object ⇒ overwrite it.
    const writeSettings = settings !== undefined;
    const settingsJson = writeSettings ? JSON.stringify(settings) : null;
    await run(
        `INSERT INTO platform_modules (module_id, status, version, imported_at, imported_by, settings, updated_at)
         VALUES ($1, 'imported', $2, NOW(), $3, $4, NOW())
         ON CONFLICT (module_id) DO UPDATE SET
            status = 'imported',
            version = EXCLUDED.version,
            imported_at = NOW(),
            imported_by = EXCLUDED.imported_by,
            settings = CASE WHEN $5::boolean THEN EXCLUDED.settings ELSE platform_modules.settings END,
            updated_at = NOW()`,
        [moduleId, version, actorId, settingsJson, writeSettings]
    );
    return getState(moduleId);
}

/**
 * Shallow-merge a patch into a row's settings JSONB (read-modify-write). Used by
 * entitlementRefresh to refresh settings.entitlement without disturbing the
 * stored manifest/package. No-op (returns current row) when the row is absent.
 */
async function mergeSettings(moduleId, patch = {}) {
    await initDB();
    const current = await getState(moduleId);
    if (!current) return null;
    const merged = { ...(current.settings || {}), ...patch };
    await run(
        `UPDATE platform_modules SET settings = $2, updated_at = NOW() WHERE module_id = $1`,
        [moduleId, JSON.stringify(merged)]
    );
    return getState(moduleId);
}

async function setRemoved(moduleId, { actorId = null } = {}) {
    await initDB();
    await run(
        `INSERT INTO platform_modules (module_id, status, removed_at, removed_by, updated_at)
         VALUES ($1, 'removed', NOW(), $2, NOW())
         ON CONFLICT (module_id) DO UPDATE SET
            status = 'removed',
            removed_at = NOW(),
            removed_by = EXCLUDED.removed_by,
            updated_at = NOW()`,
        [moduleId, actorId]
    );
    return getState(moduleId);
}

module.exports = {
    initDB,
    getAllStates,
    getState,
    setImported,
    setRemoved,
    mergeSettings,
};
