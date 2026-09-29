// @typecheck
/**
 * ISO Evidence Store — connector configuration + hashed evidence snapshots.
 *
 * Connectors fetch the MINIMUM assertion each control needs from an external
 * system (config-state depth, never a mirror), and the collector job persists
 * it here as a hashed snapshot. Checks read the latest snapshot; a hash change
 * emits CONTROL_DRIFT so the linked checks re-run immediately instead of
 * waiting for the scheduler sweep.
 *
 * Credentials are NOT stored here — a connector config references an
 * integration_connections row (orgVault-encrypted) by id; credential-less
 * connectors (DNS/TLS probes) leave connection_id NULL.
 */

const crypto = require('crypto');
const { run, getOne, getAll, exec } = require('../db');
const { makeStoreInit } = require('./lib/storeInit');

const initDB = makeStoreInit('IsoEvidenceStore', _initDB);

async function _initDB() {
    await exec(`
        CREATE TABLE IF NOT EXISTS iso_connector_configs (
            organization_id TEXT NOT NULL,
            connector_id TEXT NOT NULL,
            enabled BOOLEAN NOT NULL DEFAULT FALSE,
            connection_id TEXT,
            settings JSONB DEFAULT '{}'::jsonb,
            last_sweep_at TIMESTAMPTZ,
            last_status TEXT,
            last_error TEXT,
            updated_by TEXT,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            PRIMARY KEY (organization_id, connector_id)
        )
    `);
    await exec(`
        CREATE TABLE IF NOT EXISTS iso_evidence_snapshots (
            id SERIAL PRIMARY KEY,
            organization_id TEXT NOT NULL,
            connector_id TEXT NOT NULL,
            subject_id TEXT NOT NULL,
            fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            payload JSONB NOT NULL DEFAULT '{}'::jsonb,
            hash TEXT NOT NULL
        )
    `);
    await exec(`CREATE INDEX IF NOT EXISTS idx_iso_snap ON iso_evidence_snapshots(organization_id, connector_id, subject_id, fetched_at DESC)`);
}

function hashPayload(payload) {
    return crypto.createHash('sha256').update(JSON.stringify(payload || {})).digest('hex');
}

// ── Connector configs ──

async function listConfigs(orgId) {
    await initDB();
    return getAll(`SELECT * FROM iso_connector_configs WHERE organization_id = $1 ORDER BY connector_id`, [orgId]);
}

async function getConfig(orgId, connectorId) {
    await initDB();
    return getOne(`SELECT * FROM iso_connector_configs WHERE organization_id = $1 AND connector_id = $2`, [orgId, connectorId]);
}

async function upsertConfig(orgId, connectorId, patch, actorId) {
    await initDB();
    const existing = await getConfig(orgId, connectorId);
    const safe = {
        enabled: typeof patch.enabled === 'boolean' ? patch.enabled : (existing?.enabled ?? false),
        connection_id: patch.connection_id !== undefined ? (patch.connection_id || null) : (existing?.connection_id ?? null),
        settings: patch.settings !== undefined ? JSON.stringify(patch.settings || {}) : JSON.stringify(existing?.settings || {}),
    };
    await run(`
        INSERT INTO iso_connector_configs
            (organization_id, connector_id, enabled, connection_id, settings, updated_by, updated_at)
        VALUES ($1, $2, $3, $4, $5::jsonb, $6, NOW())
        ON CONFLICT (organization_id, connector_id) DO UPDATE SET
            enabled = EXCLUDED.enabled,
            connection_id = EXCLUDED.connection_id,
            settings = EXCLUDED.settings,
            updated_by = EXCLUDED.updated_by,
            updated_at = NOW()
    `, [orgId, connectorId, safe.enabled, safe.connection_id, safe.settings, actorId || null]);
    return getConfig(orgId, connectorId);
}

async function markSweep(orgId, connectorId, { status, error = null }) {
    await initDB();
    await run(`
        UPDATE iso_connector_configs
        SET last_sweep_at = NOW(), last_status = $3, last_error = $4
        WHERE organization_id = $1 AND connector_id = $2
    `, [orgId, connectorId, status, error ? String(error).slice(0, 500) : null]);
}

async function listEnabledConfigs() {
    await initDB();
    return getAll(`SELECT * FROM iso_connector_configs WHERE enabled = TRUE`);
}

// ── Snapshots ──

/**
 * Persist one snapshot; returns { changed, hash }. `changed` is true when the
 * payload hash differs from the previous snapshot for the same subject — the
 * drift signal the collector turns into CONTROL_DRIFT.
 */
async function saveSnapshot(orgId, connectorId, subjectId, payload) {
    await initDB();
    const hash = hashPayload(payload);
    const prev = await getOne(`
        SELECT hash FROM iso_evidence_snapshots
        WHERE organization_id = $1 AND connector_id = $2 AND subject_id = $3
        ORDER BY fetched_at DESC LIMIT 1
    `, [orgId, connectorId, subjectId]);
    // Unchanged: refresh the timestamp of the latest row instead of growing an
    // identical-row time series forever.
    if (prev?.hash === hash) {
        await run(`
            UPDATE iso_evidence_snapshots SET fetched_at = NOW()
            WHERE id = (
                SELECT id FROM iso_evidence_snapshots
                WHERE organization_id = $1 AND connector_id = $2 AND subject_id = $3
                ORDER BY fetched_at DESC LIMIT 1
            )
        `, [orgId, connectorId, subjectId]);
        return { changed: false, hash };
    }
    await run(`
        INSERT INTO iso_evidence_snapshots (organization_id, connector_id, subject_id, payload, hash)
        VALUES ($1, $2, $3, $4::jsonb, $5)
    `, [orgId, connectorId, subjectId, JSON.stringify(payload || {}), hash]);
    return { changed: true, hash };
}

async function getLatestSnapshot(orgId, connectorId, subjectId) {
    await initDB();
    return getOne(`
        SELECT * FROM iso_evidence_snapshots
        WHERE organization_id = $1 AND connector_id = $2 AND subject_id = $3
        ORDER BY fetched_at DESC LIMIT 1
    `, [orgId, connectorId, subjectId]);
}

/** Latest snapshot per subject for one connector. */
async function listLatestSnapshots(orgId, connectorId) {
    await initDB();
    return getAll(`
        SELECT DISTINCT ON (subject_id) *
        FROM iso_evidence_snapshots
        WHERE organization_id = $1 AND connector_id = $2
        ORDER BY subject_id, fetched_at DESC
    `, [orgId, connectorId]);
}

module.exports = {
    initDB,
    hashPayload,
    listConfigs,
    getConfig,
    upsertConfig,
    markSweep,
    listEnabledConfigs,
    saveSnapshot,
    getLatestSnapshot,
    listLatestSnapshots,
};
