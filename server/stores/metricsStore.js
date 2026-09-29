// @typecheck
'use strict';

/**
 * Operational / business metric rollups for the OpenObserve ops-push job
 * (server/jobs/opsMetricsPush.js). These are the Lane-B counterpart to the
 * OTEL hot-path counters: state/aggregate numbers that live in Postgres and are
 * best sampled on an interval rather than emitted per-event.
 *
 * MODEL: point-in-time SNAPSHOT GAUGES. Every collector returns the CURRENT
 * value (queue depth right now, active users in the last window, seats in use,
 * guardrail events in the last 24h). The push job stamps _timestamp=now and
 * ships them, so OpenObserve stores a time series of independent snapshots — no
 * watermark, idempotent, safe to re-run. (Event counts use a fixed rolling
 * window so each tick is self-contained and never double-counts.)
 *
 * PRIVACY: these rollups are aggregate COUNTs keyed by ORG (a tenant, not PII)
 * and low-cardinality dimensions (status, is_eu, location, violation_type). No user ids,
 * emails, names, or content. org_id → org NAME happens in the push job.
 *
 * DEFENSIVE: every collector is wrapped so a missing table/column (an install
 * that never enabled a feature) yields [] instead of throwing — telemetry must
 * never break, and a partial snapshot is fine.
 */

const { getAll } = require('../db');
const { LOC_STATE } = require('./integrationLocationSql');
const { INTERACTIVE_SOURCES } = require('../telemetry/requestClient');
const log = require('../telemetry/log');

async function safe(fn) {
    try { return (await fn()) || []; }
    catch (e) { log.warn('[metricsStore] collector failed:', e && e.message); return []; }
}

// ── Reliability / ops ────────────────────────────────────────────────────────

// In-flight automation work + Stripe billing outbox backlog. Platform-wide
// (no org dimension) — these are queue-health signals, not per-tenant.
async function opsRollup() {
    const rows = [];

    const q = await safe(() => getAll(`
        SELECT status, COUNT(*)::int AS value
          FROM automation_runs
         WHERE status IN ('queued', 'running', 'awaiting_approval', 'awaiting_form')
         GROUP BY status`));
    for (const r of q) rows.push({ metric: 'automation_queue_depth', status: r.status, value: r.value });

    const outbox = await safe(() => getAll(`
        SELECT COUNT(*)::int AS pending,
               COALESCE(EXTRACT(EPOCH FROM (NOW() - MIN(created_at))), 0)::int AS oldest_age_s,
               COUNT(*) FILTER (WHERE attempt_count > 0)::int AS retrying
          FROM payg_meter_outbox
         WHERE delivered_at IS NULL`));
    if (outbox[0]) {
        rows.push({ metric: 'outbox_pending', value: outbox[0].pending });
        rows.push({ metric: 'outbox_oldest_age_s', value: outbox[0].oldest_age_s });
        rows.push({ metric: 'outbox_retrying', value: outbox[0].retrying });
    }

    return rows;
}

// ── Product / usage ──────────────────────────────────────────────────────────

async function productRollup() {
    const rows = [];

    // Active users per org over rolling windows (distinct users who made an LLM
    // call). DAU/WAU/MAU without any per-user identity leaving the DB.
    for (const [window, interval] of [['1d', '1 day'], ['7d', '7 days'], ['30d', '30 days']]) {
        const au = await safe(() => getAll(`
            SELECT organization_id AS org_id, COUNT(DISTINCT user_id)::int AS value
              FROM ai_usage_log
             WHERE timestamp > NOW() - INTERVAL '${interval}'
             GROUP BY organization_id`));
        for (const r of au) rows.push({ metric: 'active_users', window, org_id: r.org_id || '', value: r.value });
    }

    // Interactive turns by client, last 30 days.
    //
    // The one question no query in this product could answer before the
    // `client` column existed: how much of the work happens on a phone.
    //
    // `source IN (...)` is load-bearing, not a filter for tidiness. Most rows
    // in this table come from the automation runner, cron, swarm workers and
    // title generation — the server acting on its own, legitimately recorded
    // as client 'unknown'. Including them would report every client's share
    // against a denominator set by how busy the instance happens to be, so a
    // quiet week would look like phone adoption. See INTERACTIVE_SOURCES in
    // telemetry/requestClient.js.
    const byClient = await safe(() => getAll(`
        SELECT organization_id AS org_id,
               COALESCE(client, 'unknown') AS client,
               source,
               COUNT(*)::int AS value
          FROM ai_usage_log
         WHERE timestamp > NOW() - INTERVAL '30 days'
           AND source = ANY($1)
         GROUP BY organization_id, COALESCE(client, 'unknown'), source`, [INTERACTIVE_SOURCES]));
    for (const r of byClient) {
        rows.push({
            metric: 'interactive_turns_by_client',
            window: '30d',
            org_id: r.org_id || '',
            client: r.client,
            source: r.source,
            value: r.value,
        });
    }

    // Automation runs in the last 24h by outcome — success-rate + volume signal.
    const runs = await safe(() => getAll(`
        SELECT status, COUNT(*)::int AS value,
               COALESCE(AVG(duration_ms) FILTER (WHERE duration_ms IS NOT NULL), 0)::int AS avg_duration_ms
          FROM automation_runs
         WHERE created_at > NOW() - INTERVAL '1 day'
         GROUP BY status`));
    for (const r of runs) rows.push({ metric: 'automation_runs_24h', status: r.status, value: r.value, avg_duration_ms: r.avg_duration_ms });

    // Knowledge-base footprint per org (docs + embedded chunks).
    const kb = await safe(() => getAll(`
        SELECT kb.organization_id AS org_id,
               COUNT(DISTINCT kb.id)::int AS kbs,
               COUNT(d.id)::int AS docs,
               COALESCE(SUM(d.chunk_count), 0)::int AS chunks
          FROM knowledge_bases kb
          LEFT JOIN documents d ON d.knowledge_base_id = kb.id
         GROUP BY kb.organization_id`));
    for (const r of kb) rows.push({ metric: 'kb_totals', org_id: r.org_id || '', kbs: r.kbs, docs: r.docs, chunks: r.chunks });

    return rows;
}

// ── Security / compliance ────────────────────────────────────────────────────

async function securityRollup() {
    const rows = [];

    // Guardrail / PII detections in the last 24h by type + action + direction.
    const guard = await safe(() => getAll(`
        SELECT organization_id AS org_id, violation_type, action_taken, direction,
               COUNT(*)::int AS value
          FROM guardrail_events
         WHERE timestamp > NOW() - INTERVAL '1 day'
         GROUP BY organization_id, violation_type, action_taken, direction`));
    for (const r of guard) rows.push({
        metric: 'guardrail_events_24h', org_id: r.org_id || '',
        violation_type: r.violation_type, action_taken: r.action_taken, direction: r.direction, value: r.value,
    });

    // Data sovereignty — integration/tool calls in the last 24h split by whether
    // the destination is in the EU, plus how many carried detected PII.
    // `location` is the ledger's location state (local | eu | outside |
    // via_network | unknown): five values, so a safe label.
    const sov = await safe(() => getAll(`
        SELECT organization_id AS org_id,
               COALESCE(is_eu, false) AS is_eu,
               ${LOC_STATE} AS location,
               COUNT(*)::int AS calls,
               COUNT(*) FILTER (WHERE pii_categories_detected IS NOT NULL AND pii_categories_detected <> '')::int AS pii_calls
          FROM integration_activity_log
         WHERE timestamp > NOW() - INTERVAL '1 day'
         GROUP BY 1, 2, 3`));
    for (const r of sov) rows.push({
        metric: 'integration_calls_24h', org_id: r.org_id || '',
        is_eu: !!r.is_eu, location: r.location || 'unknown', calls: r.calls, pii_calls: r.pii_calls,
    });

    // GDPR retention-job liveness — seconds since the last enforced sweep per
    // org. A large/growing value means the memoryRetentionEnforcer stopped.
    const ret = await safe(() => getAll(`
        SELECT organization_id AS org_id,
               EXTRACT(EPOCH FROM (NOW() - last_retention_run_at))::int AS value
          FROM compliance_settings
         WHERE last_retention_run_at IS NOT NULL`));
    for (const r of ret) rows.push({ metric: 'retention_run_age_s', org_id: r.org_id || '', value: r.value });

    return rows;
}

// ── Billing / licensing ──────────────────────────────────────────────────────

async function billingRollup() {
    const rows = [];

    // Stripe meter outbox — the revenue-plumbing backlog. Undelivered rows are
    // un-billed usage, so pending depth + oldest age are the money metrics.
    const outbox = await safe(() => getAll(`
        SELECT COUNT(*)::int AS pending,
               COALESCE(EXTRACT(EPOCH FROM (NOW() - MIN(created_at))), 0)::int AS oldest_age_s,
               COUNT(*) FILTER (WHERE attempt_count > 3)::int AS stuck
          FROM payg_meter_outbox
         WHERE delivered_at IS NULL`));
    if (outbox[0]) {
        rows.push({ metric: 'billing_outbox_pending', value: outbox[0].pending });
        rows.push({ metric: 'billing_outbox_oldest_age_s', value: outbox[0].oldest_age_s });
        rows.push({ metric: 'billing_outbox_stuck', value: outbox[0].stuck });
    }

    // Seats in use per org (active vs total members) — near-limit alerting.
    const seats = await safe(() => getAll(`
        SELECT "organizationId" AS org_id,
               COUNT(*)::int AS members,
               COUNT(*) FILTER (WHERE status = 'active')::int AS active
          FROM users
         WHERE "organizationId" IS NOT NULL AND "organizationId" <> ''
         GROUP BY "organizationId"`));
    for (const r of seats) rows.push({ metric: 'seats', org_id: r.org_id || '', members: r.members, active: r.active });

    // Trials — currently-running trials + lifetime count, by scope.
    const trials = await safe(() => getAll(`
        SELECT scope,
               COUNT(*) FILTER (WHERE trial_end_date > NOW())::int AS active_trials,
               COUNT(*)::int AS total_trials
          FROM trial_history
         GROUP BY scope`));
    for (const r of trials) rows.push({ metric: 'trials', scope: r.scope, active_trials: r.active_trials, total_trials: r.total_trials });

    return rows;
}

/** Collect every domain's current snapshot. Returns { ops, product, security,
 * billing } — each an array of record-ready objects (org NAME + _timestamp are
 * added by the push job). Any single collector failure degrades to []. */
async function collectAll() {
    const [ops, product, security, billing] = await Promise.all([
        opsRollup(), productRollup(), securityRollup(), billingRollup(),
    ]);
    return { ops, product, security, billing };
}

module.exports = { collectAll, opsRollup, productRollup, securityRollup, billingRollup };
