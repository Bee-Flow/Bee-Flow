'use strict';

/**
 * Periodic push of operational / business metric SNAPSHOTS into OpenObserve, so
 * reliability, product, security and billing signals can be dashboarded next to
 * the LLM usage rollups. The Lane-B companion to the OTEL hot-path counters.
 *
 * Design (mirrors usageOpenObservePush.js where it makes sense):
 *   - FULLY GATED: no-op unless OPS_PUSH_ENABLED=true AND an OpenObserve
 *     endpoint is configured (reuses the OTEL endpoint + Basic-auth header).
 *   - MULTI-POD SAFE: one Postgres advisory lock (key 0xBEEF109) so only ONE
 *     pod pushes per tick — otherwise every pod would emit the same snapshot.
 *   - SNAPSHOT MODEL: metricsStore.collectAll() returns current gauge values;
 *     each tick stamps _timestamp=now and ships them. No watermark, idempotent.
 *   - PRIVACY: aggregate COUNTs keyed by org (tenant) only — no user ids/PII.
 *     org id → org NAME (same as the usage push).
 *   - RESILIENT: background interval + fetch timeout; a down OpenObserve logs a
 *     warning and retries next tick. Never affects request latency.
 *
 * Streams (one per domain, prefix configurable via OPS_PUSH_STREAM_PREFIX):
 *   bee_ops · bee_product · bee_security · bee_billing
 */

const { pool } = require('../db');
const metricsStore = require('../stores/metricsStore');
const userStore = require('../stores/userStore');
const { recordJobRun } = require('../telemetry/metrics');
const log = require('../telemetry/log');

const LOCK_KEY = 0xBEEF109;

function parseHeaders(raw) {
    if (!raw) return {};
    const out = {};
    for (const pair of raw.split(',')) {
        const i = pair.indexOf('=');
        if (i > 0) out[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
    }
    return out;
}

function cfg() {
    const prefix = (process.env.OPS_PUSH_STREAM_PREFIX || 'bee').replace(/[^a-z0-9_]/gi, '') || 'bee';
    return {
        enabled: process.env.OPS_PUSH_ENABLED === 'true',
        base: (process.env.OTEL_EXPORTER_OTLP_ENDPOINT || '').replace(/\/+$/, ''),
        prefix,
        intervalMs: Number(process.env.OPS_PUSH_INTERVAL_MS || 60000),
        timeoutMs: Number(process.env.OPS_PUSH_TIMEOUT_MS || 8000),
        headers: parseHeaders(process.env.OTEL_EXPORTER_OTLP_HEADERS),
    };
}

// Ready only when enabled and an endpoint is configured (no salt needed — these
// rollups carry no per-user data).
function ready(c) { return !!(c.enabled && c.base); }

async function orgNameMap() {
    try {
        const orgs = await userStore.getAllOrganizations();
        const m = new Map();
        for (const o of orgs || []) m.set(o.id, o.name || o.id);
        return m;
    } catch (_) {
        return new Map();
    }
}

// Attach org_name + _timestamp to a collector row. Rows without an org_id (e.g.
// platform-wide queue depths) get no org fields.
function toRecord(row, nowMicros, orgNames) {
    const rec = Object.assign({ _timestamp: nowMicros }, row);
    if (Object.prototype.hasOwnProperty.call(row, 'org_id')) {
        rec.org_name = orgNames.get(row.org_id) || (row.org_id ? row.org_id : '(no org)');
    }
    return rec;
}

async function ingest(c, stream, records) {
    if (!records.length) return;
    const url = `${c.base}/${stream}/_json`;
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), c.timeoutMs);
    try {
        const res = await fetch(url, {
            method: 'POST',
            headers: Object.assign({ 'Content-Type': 'application/json' }, c.headers),
            body: JSON.stringify(records),
            signal: ac.signal,
        });
        const body = await res.text().catch(() => '');
        if (!res.ok) {
            throw new Error(`ingest HTTP ${res.status}: ${body.slice(0, 200)}`);
        }
        // OpenObserve returns 200 even when some records are rejected — surface
        // it so the tick is logged as a failure (next tick re-snapshots anyway).
        let failed = 0, err = '';
        try {
            const j = JSON.parse(body);
            for (const s of (j.status || [])) { failed += Number(s.failed) || 0; if (s.error) err = String(s.error); }
        } catch (_) { /* non-JSON 200 — treat as accepted */ }
        if (failed > 0) {
            throw new Error(`ingest partial failure on ${stream}: ${failed}/${records.length} rejected (${err.slice(0, 150)})`);
        }
    } finally {
        clearTimeout(t);
    }
}

async function pushSnapshot(c) {
    const snap = await metricsStore.collectAll();
    const orgNames = await orgNameMap();
    const nowMicros = Date.now() * 1000;

    const domains = [
        [`${c.prefix}_ops`, snap.ops],
        [`${c.prefix}_product`, snap.product],
        [`${c.prefix}_security`, snap.security],
        [`${c.prefix}_billing`, snap.billing],
    ];

    let pushed = 0;
    for (const [stream, rows] of domains) {
        const records = (rows || []).map((r) => toRecord(r, nowMicros, orgNames));
        await ingest(c, stream, records);
        pushed += records.length;
    }
    return { pushed };
}

// Advisory-locked entrypoint — safe to call from every pod; only one wins.
async function processOpsPush() {
    const c = cfg();
    if (!ready(c)) return;
    let acquired = false;
    let client;
    const t0 = Date.now();
    let ok = true;
    try {
        client = await pool.connect();
        const lockRes = await client.query('SELECT pg_try_advisory_lock($1) AS locked', [LOCK_KEY]);
        acquired = !!lockRes.rows[0]?.locked;
        if (!acquired) return; // another pod owns this tick
        const res = await pushSnapshot(c);
        if (res.pushed > 0) {
            log.info(`[OpsPush] pushed ${res.pushed} metric rows -> ${c.prefix}_{ops,product,security,billing}`);
        }
    } catch (e) {
        ok = false;
        log.warn('[OpsPush] push failed (will retry):', e && e.message);
    } finally {
        if (client) {
            try { if (acquired) await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]); } catch (_) { /* best-effort */ }
            client.release();
        }
        if (acquired) recordJobRun({ job: 'ops_push', status: ok ? 'ok' : 'error', durationMs: Date.now() - t0 });
    }
}

let _timer = null;

function start() {
    const c = cfg();
    if (!c.enabled) {
        log.info('[OpsPush] disabled (OPS_PUSH_ENABLED!=true) — no-op');
        return;
    }
    if (!ready(c)) {
        log.warn('[OpsPush] enabled but missing OTEL_EXPORTER_OTLP_ENDPOINT — not starting');
        return;
    }
    log.info(`[OpsPush] started: every ${c.intervalMs}ms -> ${c.base}/${c.prefix}_*`);
    _timer = setInterval(() => {
        processOpsPush().catch((e) => log.warn('[OpsPush] tick error:', e && e.message));
    }, c.intervalMs);
    _timer.unref?.();
    // Kick one run shortly after boot so data appears without waiting an interval.
    setTimeout(() => { processOpsPush().catch(() => {}); }, 8000).unref?.();
}

function stop() {
    if (_timer) { clearInterval(_timer); _timer = null; }
}

module.exports = { start, stop, processOpsPush };
