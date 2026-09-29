/**
 * ISO evidence collector — periodic sweep of every enabled evidence connector.
 *
 * Per org × connector: resolve the (optional) vault credential, call the
 * connector's collect(), persist hashed snapshots, and emit CONTROL_DRIFT for
 * the linked checks when a snapshot hash changed. Multi-replica safe via a
 * Postgres advisory lock (opsMetricsPush pattern); an in-process inFlight
 * guard keeps overlapping ticks from stacking on a slow external API.
 *
 * Depth rule: connectors fetch the minimum assertion a check needs — never a
 * mirror of the external system (cheaper, less data, hashable evidence).
 */

const { pool } = require('../db');
const isoEvidenceStore = require('../stores/isoEvidenceStore');
const connectors = require('../compliance/connectors');
const { recordJobRun } = require('../telemetry/metrics');
const log = require('../telemetry/log');

const LOCK_KEY = 0xBEEF10A;
const INTERVAL_MS = 6 * 60 * 60 * 1000; // matches the compliance scheduler cadence
const BOOT_DELAY_MS = 90 * 1000;

let _inFlight = false;
let _timer = null;

/** Sweep one org × connector config. Exported for the manual sweep route. */
async function sweepOne(config) {
    const connector = connectors.get(config.connector_id);
    if (!connector) return { ok: false, error: `unknown connector ${config.connector_id}` };
    const orgId = config.organization_id;

    let secret = null;
    if (connector.credential) {
        if (!config.connection_id) {
            await isoEvidenceStore.markSweep(orgId, config.connector_id, { status: 'error', error: 'no connection linked' });
            return { ok: false, error: 'no connection linked' };
        }
        try {
            const connStore = require('../stores/integrationConnectionStore');
            const conn = await connStore.getConnectionWithSecret(config.connection_id);
            secret = conn?.secret || null;
            if (!secret) throw new Error('connection has no secret');
        } catch (e) {
            await isoEvidenceStore.markSweep(orgId, config.connector_id, { status: 'error', error: e.message });
            return { ok: false, error: e.message };
        }
    }

    try {
        const { safeFetch } = require('../utils/ssrfGuard');
        const rows = await connector.collect({
            orgId,
            secret,
            settings: config.settings || {},
            safeFetch,
        });
        let changed = 0;
        for (const row of rows || []) {
            if (!row?.subject_id) continue;
            const r = await isoEvidenceStore.saveSnapshot(orgId, config.connector_id, String(row.subject_id), row.payload || {});
            if (r.changed) changed++;
        }
        await isoEvidenceStore.markSweep(orgId, config.connector_id, { status: 'ok' });
        if (changed > 0 && Array.isArray(connector.checks) && connector.checks.length) {
            const events = require('../compliance/events');
            events.emit(events.EVENTS.CONTROL_DRIFT, {
                orgId,
                connectorId: config.connector_id,
                checkIds: connector.checks,
            });
        }
        return { ok: true, subjects: (rows || []).length, changed };
    } catch (e) {
        await isoEvidenceStore.markSweep(orgId, config.connector_id, { status: 'error', error: e.message });
        return { ok: false, error: e.message };
    }
}

async function processSweep() {
    if (_inFlight) return;
    _inFlight = true;
    let client = null;
    let acquired = false;
    const t0 = Date.now();
    let ok = true;
    try {
        client = await pool.connect();
        const lockRes = await client.query('SELECT pg_try_advisory_lock($1) AS locked', [LOCK_KEY]);
        acquired = !!lockRes.rows[0]?.locked;
        if (!acquired) return; // another replica owns this tick
        const configs = await isoEvidenceStore.listEnabledConfigs();
        for (const config of configs) {
            const r = await sweepOne(config);
            if (!r.ok) ok = false;
        }
    } catch (e) {
        ok = false;
        log.warn('[IsoEvidenceCollector] sweep error:', e.message);
    } finally {
        if (client) {
            try { if (acquired) await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]); } catch (_) { /* best-effort */ }
            client.release();
        }
        if (acquired) recordJobRun({ job: 'iso_evidence_collect', status: ok ? 'ok' : 'error', durationMs: Date.now() - t0 });
        _inFlight = false;
    }
}

function start() {
    if (_timer) return;
    log.info(`[IsoEvidenceCollector] started: every ${INTERVAL_MS / 3600000}h`);
    _timer = setInterval(() => {
        processSweep().catch((e) => log.warn('[IsoEvidenceCollector] tick error:', e && e.message));
    }, INTERVAL_MS);
    _timer.unref?.();
    setTimeout(() => {
        processSweep().catch((e) => log.warn('[IsoEvidenceCollector] boot sweep error:', e && e.message));
    }, BOOT_DELAY_MS).unref?.();
}

module.exports = { start, processSweep, sweepOne };
