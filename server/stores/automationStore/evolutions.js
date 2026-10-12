// @typecheck
/**
 * automationStore — automation evolution proposals (automation_evolutions) and
 * the run-outcome summaries an evolution is proposed from and judged by.
 * See migrations/automation-evolution-2026-09.js for the lifecycle.
 */

const crypto = require('crypto');
const { initDB, run, getOne, getAll } = require('./core');
const { buildUpdate } = require('../lib/sqlBuilder');

function rowToEvolution(r) {
    if (!r) return null;
    const j = (v) => (typeof v === 'string' ? (() => { try { return JSON.parse(v); } catch { return null; } })() : (v ?? null));
    const ts = (v) => (v ? new Date(v).toISOString() : null);
    return {
        id: r.id,
        automationId: r.automation_id,
        userId: r.user_id,
        status: r.status,
        rationale: r.rationale || null,
        expectedEffect: r.expected_effect || null,
        risk: r.risk || null,
        plan: j(r.plan) || [],
        versionBefore: r.version_before ?? null,
        versionAfter: r.version_after ?? null,
        baseline: j(r.baseline),
        canary: j(r.canary),
        canaryRuns: r.canary_runs ?? 20,
        error: r.error || null,
        createdAt: ts(r.created_at),
        appliedAt: ts(r.applied_at),
        evaluatedAt: ts(r.evaluated_at),
        updatedAt: ts(r.updated_at),
    };
}

async function createEvolution({ automationId, userId, rationale = null, expectedEffect = null, risk = null, plan = [], canaryRuns = 20 }) {
    await initDB();
    const id = crypto.randomUUID();
    await run(
        `INSERT INTO automation_evolutions (id, automation_id, user_id, status, rationale, expected_effect, risk, plan, canary_runs)
         VALUES ($1, $2, $3, 'proposed', $4, $5, $6, $7::jsonb, $8)`,
        [id, automationId, userId, rationale, expectedEffect, risk, JSON.stringify(plan || []), Math.max(1, Math.min(200, Number(canaryRuns) || 20))],
    );
    return getEvolution(id);
}

async function getEvolution(id) {
    await initDB();
    return rowToEvolution(await getOne('SELECT * FROM automation_evolutions WHERE id = $1', [id]));
}

async function listEvolutions(automationId, { limit = 20 } = {}) {
    await initDB();
    const rows = await getAll(
        'SELECT * FROM automation_evolutions WHERE automation_id = $1 ORDER BY created_at DESC LIMIT $2',
        [automationId, Math.max(1, Math.min(200, limit))],
    );
    return rows.map(rowToEvolution);
}

const asJsonb = { cast: 'jsonb', transform: (v) => JSON.stringify(v) };
const PATCH_COLUMNS = {
    status: 'status', error: 'error', versionBefore: 'version_before', versionAfter: 'version_after',
    baseline: { col: 'baseline', ...asJsonb }, canary: { col: 'canary', ...asJsonb },
    appliedAt: 'applied_at', evaluatedAt: 'evaluated_at',
};

async function updateEvolution(id, patch = {}) {
    await initDB();
    const built = buildUpdate({
        table: 'automation_evolutions',
        updates: patch,
        columnMap: PATCH_COLUMNS,
        extraSet: ['updated_at = NOW()'],
        where: [{ col: 'id', value: id }],
    });
    if (!built) return getEvolution(id);
    await run(built.sql, built.params);
    return getEvolution(id);
}

async function listCanaryEvolutions() {
    await initDB();
    const rows = await getAll(`SELECT * FROM automation_evolutions WHERE status = 'canary' ORDER BY applied_at ASC LIMIT 200`);
    return rows.map(rowToEvolution);
}

/**
 * Outcome summary of one automation's LIVE runs: totals by status and error
 * class, handled errors, average duration, and a per-root breakdown. `since`
 * (ISO) bounds the window; `minVersion` restricts to runs of that definition
 * version or later — the canary reads only the runs of the new version.
 */
async function runOutcomeSummary(automationId, { since = null, minVersion = null } = {}) {
    await initDB();
    const params = [automationId];
    let clause = `r.automation_id = $1 AND r.mode = 'live'`;
    if (since) { params.push(since); clause += ` AND r.started_at >= $${params.length}`; }
    if (Number.isInteger(minVersion)) { params.push(minVersion); clause += ` AND r.version >= $${params.length}`; }
    const rows = await getAll(
        `SELECT r.status, r.error_class, r.root_step_id, r.handled_error_count, r.duration_ms
           FROM automation_runs r
          WHERE ${clause}`,
        params,
    );
    const byStatus = {};
    const byErrorClass = {};
    const byRoot = {};
    let handled = 0, durTotal = 0, durCount = 0;
    for (const r of rows) {
        byStatus[r.status] = (byStatus[r.status] || 0) + 1;
        if (r.error_class) byErrorClass[r.error_class] = (byErrorClass[r.error_class] || 0) + 1;
        const root = r.root_step_id || 'primary';
        byRoot[root] = byRoot[root] || { rootStepId: root, total: 0, failed: 0 };
        byRoot[root].total += 1;
        if (r.status === 'error' || r.status === 'failed') byRoot[root].failed += 1;
        handled += Number(r.handled_error_count || 0);
        if (r.duration_ms != null) { durTotal += Number(r.duration_ms); durCount += 1; }
    }
    const total = rows.length;
    const failed = (byStatus.error || 0) + (byStatus.failed || 0);
    return {
        total,
        failed,
        failureRate: total ? Number((failed / total).toFixed(3)) : 0,
        byStatus,
        byErrorClass,
        handledErrors: handled,
        avgDurationMs: durCount ? Math.round(durTotal / durCount) : null,
        byRoot: Object.values(byRoot),
    };
}

module.exports = { createEvolution, getEvolution, listEvolutions, updateEvolution, listCanaryEvolutions, runOutcomeSummary, rowToEvolution };
