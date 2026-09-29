// @typecheck
/**
 * Platform Release Store — which builds of Bee Flow this installation has
 * run (CRA Art. 13 / Annex I part II: a record of releases and their SBOM).
 *
 * One row per build sha, written by the SBOM locator at boot
 * (compliance/lib/sbomLocator.js) and read by the CRA SBOM and
 * security-update checks. Platform-wide — there is no organisation here: the
 * build is the same for every tenant of this server. `first_seen_at` is when
 * THIS installation first booted that build, not the upstream release date.
 */

const { run, getOne, getAll, exec } = require('../db');
const { makeStoreInit } = require('./lib/storeInit');

const initDB = makeStoreInit('PlatformReleaseStore', _initDB);

async function _initDB() {
    await exec(`
        CREATE TABLE IF NOT EXISTS platform_release_log (
            build_sha TEXT PRIMARY KEY,
            app_version TEXT,
            first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            sbom_hash TEXT
        )
    `);
    await exec(`CREATE INDEX IF NOT EXISTS idx_platform_release_seen ON platform_release_log(first_seen_at DESC)`);
}

const SHA_RE = /^[0-9a-f]{7,64}$/;
const HEX64_RE = /^[0-9a-f]{64}$/;

function _sha(v) {
    const s = String(v || '').trim().toLowerCase();
    if (!SHA_RE.test(s)) throw new Error('buildSha must be a hex git sha (7–64 chars)');
    return s;
}

/**
 * Record that this build is running. Idempotent on build_sha: a later boot
 * of the same build keeps `first_seen_at` and only fills in an SBOM hash /
 * version that was missing (or changed) — a rebuilt SBOM for the same sha is
 * the newer truth.
 *
 * @param {{buildSha?:string, appVersion?:string|null, sbomHash?:string|null}} [input]
 * @returns {Promise<{build_sha, app_version, first_seen_at, sbom_hash, inserted:boolean}>}
 */
async function upsertSeen({ buildSha, appVersion, sbomHash } = {}) {
    await initDB();
    const sha = _sha(buildSha);
    const version = appVersion == null ? null : String(appVersion).trim().slice(0, 64) || null;
    let sbom = null;
    if (sbomHash != null && String(sbomHash).trim() !== '') {
        sbom = String(sbomHash).trim().toLowerCase();
        if (!HEX64_RE.test(sbom)) throw new Error('sbomHash must be a sha256 hex digest');
    }
    const { rows } = await run(`
        INSERT INTO platform_release_log (build_sha, app_version, sbom_hash)
        VALUES ($1, $2, $3)
        ON CONFLICT (build_sha) DO UPDATE SET
            app_version = COALESCE(EXCLUDED.app_version, platform_release_log.app_version),
            sbom_hash = COALESCE(EXCLUDED.sbom_hash, platform_release_log.sbom_hash)
        RETURNING build_sha, app_version, first_seen_at, sbom_hash, (xmax = 0) AS inserted
    `, [sha, version, sbom]);
    return rows[0] || null;
}

/** The build seen most recently — normally the one running now. */
async function latest() {
    await initDB();
    return getOne(`
        SELECT build_sha, app_version, first_seen_at, sbom_hash
        FROM platform_release_log
        ORDER BY first_seen_at DESC
        LIMIT 1
    `, []);
}

async function get(buildSha) {
    await initDB();
    return getOne(`
        SELECT build_sha, app_version, first_seen_at, sbom_hash
        FROM platform_release_log
        WHERE build_sha = $1
    `, [_sha(buildSha)]);
}

/** Newest first. */
async function listRecent(limit = 20) {
    await initDB();
    const n = Number.isInteger(Number(limit)) && Number(limit) > 0 ? Math.min(Number(limit), 500) : 20;
    return getAll(`
        SELECT build_sha, app_version, first_seen_at, sbom_hash
        FROM platform_release_log
        ORDER BY first_seen_at DESC
        LIMIT $1
    `, [n]);
}


// ── Names the PLD Art. 9 release-record check calls ──────────────────────
// The check (compliance/checks/pld/art9-release-record.js) was written against
// this vocabulary in parallel with the store; both spellings stay so neither
// side needs a rename. `recordBuild` takes the check's snake_case row.
/**
 * @param {{ build_sha?: string, app_version?: string, sbom_hash?: string }} [opts]
 */
async function recordBuild({ build_sha, app_version, sbom_hash } = {}) {
    return upsertSeen({ buildSha: build_sha, appVersion: app_version, sbomHash: sbom_hash });
}

/** The build seen immediately BEFORE `buildSha` (by first_seen_at), or null. */
async function getPreviousBuild(buildSha) {
    await initDB();
    return getOne(`
        SELECT build_sha, app_version, first_seen_at, sbom_hash
        FROM platform_release_log
        WHERE build_sha <> $1
          AND first_seen_at < COALESCE((SELECT first_seen_at FROM platform_release_log WHERE build_sha = $1), NOW())
        ORDER BY first_seen_at DESC
        LIMIT 1
    `, [_sha(buildSha)]);
}

async function countBuilds() {
    await initDB();
    const row = await getOne(`SELECT COUNT(*)::int AS n FROM platform_release_log`, []);
    return row ? Number(row.n) : 0;
}

module.exports = {
    initDB,
    upsertSeen,
    latest,
    get,
    listRecent,
    recordBuild,
    getPreviousBuild,
    countBuilds,
};
