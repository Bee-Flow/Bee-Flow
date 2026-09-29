'use strict';

/**
 * Periodic push of aggregated `ai_usage_log` rollups into an OpenObserve stream,
 * so token usage + cost can be shown per-organization and per-user in an
 * OpenObserve dashboard.
 *
 * Design:
 *   - FULLY GATED: no-op unless USAGE_PUSH_ENABLED=true AND an OpenObserve
 *     endpoint + hash salt are configured. Dev/self-host stay clean.
 *   - MULTI-POD SAFE: wrapped in a Postgres advisory lock (mirrors
 *     automationRunner.processRunRetention) so only ONE of the N server pods
 *     pushes per tick. Key 0xBEEF108.
 *   - PRIVACY: user ids are pseudonymized (HMAC-SHA256 + salt, truncated) —
 *     no names/emails ever leave the app. Org id → org NAME (tenant, not PII).
 *   - IDEMPOTENT: only CLOSED hour buckets are pushed (bucket_end < now-grace);
 *     the watermark advances only after a 2xx, so a bucket is never re-read.
 *   - RESILIENT: background interval + fetch timeout; a down/slow OpenObserve
 *     logs a warning, does NOT advance the watermark, and retries next tick —
 *     it never affects Bee Flow request latency.
 *
 * Ingest URL + auth reuse the OTEL env vars (the app already trusts them with
 * the OpenObserve Basic auth); the target stream is configurable so local
 * testing can push to a `ai_usage_test` stream on the live instance.
 */

const crypto = require('crypto');
const { pool } = require('../db');
const usageStore = require('../stores/usageStore');
const configStore = require('../stores/configStore');
const userStore = require('../stores/userStore');
const { computeCostSplit } = require('../core/llm/modelCosts');
const { recordJobRun } = require('../telemetry/metrics');
const log = require('../telemetry/log');

const LOCK_KEY = 0xBEEF108;
const WATERMARK_KEY = 'usage_openobserve_watermark';
const HOUR_MS = 60 * 60 * 1000;

function parseHeaders(raw) {
    if (!raw) return {};
    const out = {};
    for (const pair of raw.split(',')) {
        const i = pair.indexOf('=');
        if (i > 0) out[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
    }
    return out;
}

// The `estimated_cost`/`billed_cost` in ai_usage_log are stored ALREADY
// FX-converted by logUsage: self-host => USD (fx=1, so the exact stored value),
// cloud => plan currency (EUR default). Derive the dashboard label to match so
// the numbers are never mislabeled. `USAGE_PUSH_CURRENCY` overrides.
function resolveCurrency() {
    if (process.env.USAGE_PUSH_CURRENCY) return process.env.USAGE_PUSH_CURRENCY;
    return (process.env.DEPLOYMENT_MODE || 'cloud') === 'cloud' ? 'EUR' : 'USD';
}

function cfg() {
    return {
        enabled: process.env.USAGE_PUSH_ENABLED === 'true',
        base: (process.env.OTEL_EXPORTER_OTLP_ENDPOINT || '').replace(/\/+$/, ''),
        stream: process.env.USAGE_PUSH_STREAM || 'ai_usage',
        salt: process.env.USAGE_HASH_SALT || '',
        currency: resolveCurrency(),
        // Bucket size: 'hour' (prod default) | 'minute' (responsive local test) | 'day'.
        bucket: ['minute', 'hour', 'day'].includes(process.env.USAGE_PUSH_BUCKET) ? process.env.USAGE_PUSH_BUCKET : 'hour',
        backfillDays: Number(process.env.USAGE_PUSH_BACKFILL_DAYS || 7),
        intervalMs: Number(process.env.USAGE_PUSH_INTERVAL_MS || 900000),
        timeoutMs: Number(process.env.USAGE_PUSH_TIMEOUT_MS || 8000),
        graceMs: Number(process.env.USAGE_PUSH_GRACE_MS || 10 * 60 * 1000),
        headers: parseHeaders(process.env.OTEL_EXPORTER_OTLP_HEADERS),
    };
}

// Ready to run only when enabled, with an endpoint, and a salt (per-user
// pseudonymization must be configured — refuse to push raw-ish data otherwise).
function ready(c) { return !!(c.enabled && c.base && c.salt); }

function hashUser(userId, salt) {
    if (!userId) return 'none';
    return crypto.createHmac('sha256', salt).update(String(userId)).digest('hex').slice(0, 16);
}

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

function toRecord(r, c, orgNames) {
    const bucketMs = new Date(r.bucket).getTime();
    const orgId = r.organization_id || '';
    const prompt = Number(r.prompt_tokens) || 0;
    const completion = Number(r.completion_tokens) || 0;
    const cached = Number(r.cached_tokens) || 0;
    const cacheCreation = Number(r.cache_creation_tokens) || 0;
    const estimated = Number(r.estimated_cost) || 0;

    // Split the authoritative total cost into input/output using the same
    // pricing logic the product uses (computeCostSplit), passing cache_ttl so the
    // cache-write premium (1.25× 5m / 2× 1h) is weighted correctly. Apportion by
    // ratio so input_cost + output_cost == estimated_cost regardless of currency/FX.
    const split = computeCostSplit(r.model, prompt, completion, cached, cacheCreation, r.cache_ttl || null);
    const rawSplit = (split.input_cost || 0) + (split.output_cost || 0);
    const inputCost = rawSplit > 0 ? estimated * (split.input_cost / rawSplit) : 0;
    const outputCost = rawSplit > 0 ? estimated * (split.output_cost / rawSplit) : estimated;
    const round4 = (n) => Math.round(n * 10000) / 10000;

    return {
        _timestamp: bucketMs * 1000, // OpenObserve _timestamp is microseconds
        bucket_start: new Date(bucketMs).toISOString(),
        org_id: orgId,
        org_name: orgNames.get(orgId) || (orgId ? orgId : '(no org)'),
        user_hash: hashUser(r.user_id, c.salt),
        model: r.model || 'unknown',
        calls: Number(r.calls) || 0,
        prompt_tokens: prompt,           // input tokens
        completion_tokens: completion,   // output tokens
        total_tokens: Number(r.total_tokens) || 0,
        cached_tokens: cached,
        cache_creation_tokens: cacheCreation,
        input_cost: round4(inputCost),
        output_cost: round4(outputCost),
        estimated_cost: estimated,
        billed_cost: Number(r.billed_cost) || 0,
        currency: c.currency,
    };
}

async function ingest(c, records) {
    const url = `${c.base}/${c.stream}/_json`;
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
        // OpenObserve returns HTTP 200 even when some records are REJECTED (e.g.
        // older than ZO_INGEST_ALLOWED_UPTO): {"status":[{successful,failed,error}]}.
        // Treat ANY failure as an error so the watermark is NOT advanced past the
        // rejected buckets — they're retried next tick instead of being silently
        // lost.
        let failed = 0, err = '';
        try {
            const j = JSON.parse(body);
            for (const s of (j.status || [])) { failed += Number(s.failed) || 0; if (s.error) err = String(s.error); }
        } catch (_) { /* non-JSON 200 body — treat as fully accepted */ }
        if (failed > 0) {
            throw new Error(`ingest partial failure: ${failed}/${records.length} rejected (${err.slice(0, 150)})`);
        }
    } finally {
        clearTimeout(t);
    }
}

// Push all CLOSED hour buckets since the watermark. Throws on ingest failure so
// the watermark is NOT advanced (retry next tick).
async function pushSince(c) {
    const now = Date.now();
    const bucketMs = { minute: 60 * 1000, hour: HOUR_MS, day: 24 * HOUR_MS }[c.bucket] || HOUR_MS;
    // Upper bound: last fully-closed bucket boundary, minus a grace period so
    // late-committing rows in the current/just-past bucket aren't missed.
    const cutoff = Math.floor((now - c.graceMs) / bucketMs) * bucketMs;

    const wm = await configStore.getConfig(WATERMARK_KEY);
    let fromMs = (wm != null && Number.isFinite(Number(wm)))
        ? Number(wm)
        : Math.floor((now - c.backfillDays * 24 * HOUR_MS) / bucketMs) * bucketMs;

    if (fromMs >= cutoff) return { pushed: 0, from: fromMs, to: cutoff }; // nothing newly closed

    const rows = await usageStore.getUsageRollup({
        startDate: new Date(fromMs).toISOString(),
        endDate: new Date(cutoff - 1).toISOString(),
    }, c.bucket);

    if (rows && rows.length) {
        const orgNames = await orgNameMap();
        await ingest(c, rows.map((r) => toRecord(r, c, orgNames)));
    }
    // Advance watermark only after a successful ingest (or empty range).
    await configStore.setConfig(WATERMARK_KEY, String(cutoff));
    return { pushed: rows ? rows.length : 0, from: fromMs, to: cutoff };
}

// Advisory-locked entrypoint — safe to call from every pod; only one wins.
async function processUsagePush() {
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
        const res = await pushSince(c);
        if (res.pushed > 0) {
            log.info(`[UsagePush] pushed ${res.pushed} rollup rows for `
                + `[${new Date(res.from).toISOString()} .. ${new Date(res.to).toISOString()}) -> ${c.stream}`);
        }
    } catch (e) {
        // Best-effort: log and keep the watermark; retried next tick.
        ok = false;
        log.warn('[UsagePush] push failed (will retry):', e && e.message);
    } finally {
        if (client) {
            try { if (acquired) await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]); } catch (_) { /* best-effort */ }
            client.release();
        }
        // Only the pod that won the lock actually ran — record its liveness.
        if (acquired) recordJobRun({ job: 'usage_push', status: ok ? 'ok' : 'error', durationMs: Date.now() - t0 });
    }
}

let _timer = null;

function start() {
    const c = cfg();
    if (!c.enabled) {
        log.info('[UsagePush] disabled (USAGE_PUSH_ENABLED!=true) — no-op');
        return;
    }
    if (!ready(c)) {
        log.warn('[UsagePush] enabled but missing OTEL_EXPORTER_OTLP_ENDPOINT or USAGE_HASH_SALT — not starting');
        return;
    }
    log.info(`[UsagePush] started: every ${c.intervalMs}ms -> ${c.base}/${c.stream}/_json`);
    _timer = setInterval(() => {
        processUsagePush().catch((e) => log.warn('[UsagePush] tick error:', e && e.message));
    }, c.intervalMs);
    _timer.unref?.();
    // Kick one run shortly after boot (unref'd) so data appears without waiting a full interval.
    setTimeout(() => { processUsagePush().catch(() => {}); }, 5000).unref?.();
}

function stop() {
    if (_timer) { clearInterval(_timer); _timer = null; }
}

module.exports = { start, stop, processUsagePush };
