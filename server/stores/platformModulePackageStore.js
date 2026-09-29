// @typecheck
/**
 * Platform Module Package Store — one row per (module_id, version) of a
 * DOWNLOADED remote module package, tracking its on-disk staging outcome.
 *
 * This is the durable ledger the boot re-verify loop reads
 * (packageLoader.loadInstalledAtBoot): which versions were staged, whether each
 * activated (`active`), failed verification/activation (`failed`) or is
 * incompatible with this product build (`incompatible`), plus the signed
 * manifest, signing kid and package sha256 for re-verification from disk.
 *
 * Sibling of platformModuleStore.js (which owns imported/removed RUNTIME state).
 * A module is "running" only when it has BOTH an 'imported' platform_modules row
 * AND an 'active' platform_module_packages row.
 */

const { run, getOne, getAll, exec } = require('../db');
const { makeStoreInit } = require('./lib/storeInit');
const { runDdl } = require('./lib/_ddl');
const log = require('../telemetry/log');
const { parseJSONObject: parseJSON } = require('./lib/json');

const initDB = makeStoreInit('PlatformModulePackageStore', _initDB);

async function _initDB() {

    await exec(`
        CREATE TABLE IF NOT EXISTS platform_module_packages (
            module_id TEXT NOT NULL,
            version TEXT NOT NULL,
            status TEXT NOT NULL CHECK (status IN ('active','failed','incompatible','retired','staged','quarantined')),
            manifest JSONB,
            kid TEXT,
            package_sha256 TEXT,
            error TEXT,
            source TEXT NOT NULL DEFAULT 'hub',
            pruned_at TIMESTAMPTZ,
            installed_at TIMESTAMPTZ,
            installed_by TEXT,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            PRIMARY KEY (module_id, version)
        );
    `);
    // Forward-compat ALTERs (idempotent) for older deploys. Via runDdl
    // (stores/lib/_ddl.js): fouten per statement luid verzameld i.p.v. stil
    // als "already present" — de DROP/ADD/VALIDATE-reeks hieronder slaagt
    // idempotent, dus elke fout hier is een échte.
    await runDdl('platformModulePackageStore', [
        `ALTER TABLE platform_module_packages ADD COLUMN IF NOT EXISTS manifest JSONB`,
        `ALTER TABLE platform_module_packages ADD COLUMN IF NOT EXISTS kid TEXT`,
        `ALTER TABLE platform_module_packages ADD COLUMN IF NOT EXISTS package_sha256 TEXT`,
        `ALTER TABLE platform_module_packages ADD COLUMN IF NOT EXISTS error TEXT`,
        `ALTER TABLE platform_module_packages ADD COLUMN IF NOT EXISTS installed_by TEXT`,
        `ALTER TABLE platform_module_packages ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'hub'`,
        `ALTER TABLE platform_module_packages ADD COLUMN IF NOT EXISTS pruned_at TIMESTAMPTZ`,
        // Widen the status CHECK for pre-3.1 deploys (whose constraint only
        // allowed active|failed|incompatible). NOT VALID + VALIDATE keeps the
        // ALTER lock-cheap; existing rows all satisfy the wider set.
        `ALTER TABLE platform_module_packages DROP CONSTRAINT IF EXISTS platform_module_packages_status_check`,
        `ALTER TABLE platform_module_packages ADD CONSTRAINT platform_module_packages_status_check
            CHECK (status IN ('active','failed','incompatible','retired','staged','quarantined')) NOT VALID`,
        `ALTER TABLE platform_module_packages VALIDATE CONSTRAINT platform_module_packages_status_check`,
    ]);
    log.info('[PlatformModulePackageStore] PostgreSQL initialized');
}


function mapRow(r) {
    if (!r) return null;
    return {
        moduleId: r.module_id,
        version: r.version,
        status: r.status,
        manifest: parseJSON(r.manifest, null),
        kid: r.kid || null,
        packageSha256: r.package_sha256 || null,
        error: r.error || null,
        source: r.source || 'hub',
        prunedAt: r.pruned_at ? new Date(r.pruned_at).toISOString() : null,
        installedAt: r.installed_at ? new Date(r.installed_at).toISOString() : null,
        installedBy: r.installed_by || null,
        updatedAt: r.updated_at ? new Date(r.updated_at).toISOString() : null,
    };
}

/**
 * Mark a package version active (successful stage + activate). Any OTHER version
 * of the same module that was previously active is RETIRED — it stays a
 * rollback candidate until the retention GC prunes its file.
 */
async function setActive(moduleId, version, { manifest = null, kid = null, packageSha256 = null, actorId = null, source = null } = {}) {
    await initDB();
    await run(
        `INSERT INTO platform_module_packages
            (module_id, version, status, manifest, kid, package_sha256, error, source, installed_at, installed_by, updated_at)
         VALUES ($1, $2, 'active', $3, $4, $5, NULL, COALESCE($7, 'hub'), NOW(), $6, NOW())
         ON CONFLICT (module_id, version) DO UPDATE SET
            status = 'active',
            manifest = EXCLUDED.manifest,
            kid = EXCLUDED.kid,
            package_sha256 = EXCLUDED.package_sha256,
            error = NULL,
            source = COALESCE($7, platform_module_packages.source),
            installed_at = COALESCE(platform_module_packages.installed_at, NOW()),
            installed_by = COALESCE(EXCLUDED.installed_by, platform_module_packages.installed_by),
            updated_at = NOW()`,
        [moduleId, version, manifest ? JSON.stringify(manifest) : null, kid, packageSha256, actorId, source]
    );
    // Demote any other active version of this module.
    await run(
        `UPDATE platform_module_packages
            SET status = 'retired', updated_at = NOW()
          WHERE module_id = $1 AND version <> $2 AND status = 'active'`,
        [moduleId, version]
    );
    return getPackage(moduleId, version);
}

/**
 * Mark a version staged: verified + extracted but NOT activated (a package
 * needing a restart — native addon / restart:'always'). Boot processes staged
 * rows first.
 */
async function setStaged(moduleId, version, { manifest = null, kid = null, packageSha256 = null, actorId = null, source = null } = {}) {
    await initDB();
    await run(
        `INSERT INTO platform_module_packages
            (module_id, version, status, manifest, kid, package_sha256, error, source, installed_at, installed_by, updated_at)
         VALUES ($1, $2, 'staged', $3, $4, $5, NULL, COALESCE($7, 'hub'), NOW(), $6, NOW())
         ON CONFLICT (module_id, version) DO UPDATE SET
            status = 'staged',
            manifest = EXCLUDED.manifest,
            kid = EXCLUDED.kid,
            package_sha256 = EXCLUDED.package_sha256,
            error = NULL,
            source = COALESCE($7, platform_module_packages.source),
            installed_by = COALESCE(EXCLUDED.installed_by, platform_module_packages.installed_by),
            updated_at = NOW()`,
        [moduleId, version, manifest ? JSON.stringify(manifest) : null, kid, packageSha256, actorId, source]
    );
    return getPackage(moduleId, version);
}

/** Crash-quarantine a version (survives restart; boot skips it). */
async function setQuarantined(moduleId, version, { error = null } = {}) {
    await initDB();
    await run(
        `UPDATE platform_module_packages
            SET status = 'quarantined', error = $3, updated_at = NOW()
          WHERE module_id = $1 AND version = $2`,
        [moduleId, version, error ? String(error).slice(0, 2000) : null]
    );
    return getPackage(moduleId, version);
}

/** Stamp a retired version's package file as pruned by the retention GC. */
async function markPruned(moduleId, version) {
    await initDB();
    await run(
        `UPDATE platform_module_packages SET pruned_at = NOW(), updated_at = NOW()
          WHERE module_id = $1 AND version = $2`,
        [moduleId, version]
    );
    return getPackage(moduleId, version);
}

/** Staged rows (restart-pending updates), oldest first — boot processes these first. */
async function listStaged() {
    await initDB();
    const rows = await getAll(`SELECT * FROM platform_module_packages WHERE status = 'staged' ORDER BY updated_at ASC`);
    return rows.map(mapRow);
}

/** Retired, un-pruned versions of a module (newest first) — rollback candidates. */
async function listRollbackCandidates(moduleId) {
    await initDB();
    const rows = await getAll(
        `SELECT * FROM platform_module_packages
          WHERE module_id = $1 AND status = 'retired' AND pruned_at IS NULL
          ORDER BY updated_at DESC`,
        [moduleId]
    );
    return rows.map(mapRow);
}

/**
 * Mark a package version failed/incompatible with the recorded error. Never
 * throws away the manifest we already have — a boot re-verify may have it.
 */
async function setFailed(moduleId, version, { error = null, status = 'failed', kid = null, packageSha256 = null, manifest = null, actorId = null } = {}) {
    await initDB();
    const st = status === 'incompatible' ? 'incompatible' : 'failed';
    await run(
        `INSERT INTO platform_module_packages
            (module_id, version, status, manifest, kid, package_sha256, error, installed_at, installed_by, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), $8, NOW())
         ON CONFLICT (module_id, version) DO UPDATE SET
            status = EXCLUDED.status,
            manifest = COALESCE(EXCLUDED.manifest, platform_module_packages.manifest),
            kid = COALESCE(EXCLUDED.kid, platform_module_packages.kid),
            package_sha256 = COALESCE(EXCLUDED.package_sha256, platform_module_packages.package_sha256),
            error = EXCLUDED.error,
            updated_at = NOW()`,
        [moduleId, version, st, manifest ? JSON.stringify(manifest) : null, kid, packageSha256, error ? String(error).slice(0, 2000) : null, actorId]
    );
    return getPackage(moduleId, version);
}

async function getPackage(moduleId, version) {
    await initDB();
    return mapRow(await getOne(
        `SELECT * FROM platform_module_packages WHERE module_id = $1 AND version = $2`,
        [moduleId, version]
    ));
}

/** The currently-active version row for a module (if any). */
async function getActive(moduleId) {
    await initDB();
    return mapRow(await getOne(
        `SELECT * FROM platform_module_packages WHERE module_id = $1 AND status = 'active' ORDER BY updated_at DESC LIMIT 1`,
        [moduleId]
    ));
}

/** Every active package row (one per module) — the boot activation set. */
async function listActive() {
    await initDB();
    const rows = await getAll(`SELECT * FROM platform_module_packages WHERE status = 'active' ORDER BY module_id`);
    return rows.map(mapRow);
}

async function listForModule(moduleId) {
    await initDB();
    const rows = await getAll(`SELECT * FROM platform_module_packages WHERE module_id = $1 ORDER BY updated_at DESC`, [moduleId]);
    return rows.map(mapRow);
}

module.exports = {
    initDB,
    setActive,
    setStaged,
    setQuarantined,
    setFailed,
    markPruned,
    getPackage,
    getActive,
    listActive,
    listStaged,
    listRollbackCandidates,
    listForModule,
};
