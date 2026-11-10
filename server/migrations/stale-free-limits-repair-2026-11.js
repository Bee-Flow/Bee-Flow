#!/usr/bin/env node
// @typecheck
/**
 * Migration (MANUAL): clear the Free-tier limit overrides that paid orgs kept
 * after an upgrade (BFSF-249, see BFSF-245).
 *
 * ── WHY ─────────────────────────────────────────────────────────────
 * organization_subscriptions.max_* are per-org OVERRIDES that win over the
 * plan. Orgs that moved from Free to a paid plan (Launch, ...) before the
 * fix kept max_agents = 5 and max_knowledge_sources = 3 in their row, so a
 * paying customer was still capped at the Free limits. The store now clears
 * the overrides on every plan assignment; this repairs the rows written before.
 *
 * ── WHAT IT TOUCHES ─────────────────────────────────────────────────
 * Only rows that carry the exact Free signature, both values together
 * (max_agents = 5 AND max_knowledge_sources = 3), on a plan with a price
 * above 0 whose own caps are more generous (NULL or higher) for both. Only
 * those two columns are set to NULL; every other override stays. A deliberate
 * admin override of exactly 5 and 3 on a paid plan is indistinguishable,
 * which is why this does not run at boot: run --dry-run first and read the list.
 *
 * ── REVERSIBLE ──────────────────────────────────────────────────────
 * Every cleared row gets a subscription_audit_log row (action
 * 'stale_free_limits_cleared', old_values = the two values). `--revert`
 * writes them back, but only into a column that is still NULL, so an admin
 * edit made after the repair is never overwritten.
 *
 * Idempotent: a repaired row no longer matches. Usage:
 *   node server/migrations/stale-free-limits-repair-2026-11.js --dry-run
 *   node server/migrations/stale-free-limits-repair-2026-11.js
 *   node server/migrations/stale-free-limits-repair-2026-11.js --revert
 */

'use strict';

const crypto = require('crypto');
const { run, getAll } = require('../db');

const ACTION = 'stale_free_limits_cleared';
const REVERT_ACTION = 'stale_free_limits_restored';
const CHANGED_BY = 'migration:stale-free-limits-repair-2026-11';
const FREE_AGENTS = 5;
const FREE_KNOWLEDGE_SOURCES = 3;

/** @param {string} action @param {string} orgId @param {unknown} oldValues @param {unknown} newValues */
async function audit(action, orgId, oldValues, newValues) {
    await run(
        `INSERT INTO subscription_audit_log (id, action, target_type, target_id, changed_by, old_values, new_values)
         VALUES ($1, $2, 'org_subscription', $3, $4, $5, $6)`,
        [crypto.randomUUID(), action, orgId, CHANGED_BY, JSON.stringify(oldValues), JSON.stringify(newValues)],
    );
}

/** The paid-plan rows that still carry the Free signature. */
async function findStale() {
    return getAll(
        `SELECT os.organization_id, os.plan_id, sp.name AS plan_name
           FROM organization_subscriptions os
           JOIN subscription_plans sp ON sp.id = os.plan_id
          WHERE sp.price > 0
            AND os.max_agents = $1 AND os.max_knowledge_sources = $2
            AND (sp.max_agents IS NULL OR sp.max_agents > $1)
            AND (sp.max_knowledge_sources IS NULL OR sp.max_knowledge_sources > $2)
          ORDER BY os.organization_id`,
        [FREE_AGENTS, FREE_KNOWLEDGE_SOURCES],
    );
}

/**
 * @param {{ dryRun?: boolean }} [opts]
 * @returns {Promise<{ found: number, cleared: number, orgIds: string[] }>}
 */
async function up({ dryRun = false } = {}) {
    const rows = await findStale();
    const orgIds = rows.map(r => r.organization_id);
    if (dryRun) {
        for (const r of rows) console.log(`[stale-free-limits] would clear org ${r.organization_id} (plan ${r.plan_name})`);
        console.log(`[stale-free-limits] dry run: ${rows.length} org(s) would be repaired`);
        return { found: rows.length, cleared: 0, orgIds };
    }
    let cleared = 0;
    for (const r of rows) {
        // The guard repeats the signature: a row an admin changed since the
        // SELECT is left alone.
        const res = await run(
            `UPDATE organization_subscriptions
                SET max_agents = NULL, max_knowledge_sources = NULL, updated_at = NOW()
              WHERE organization_id = $1 AND max_agents = $2 AND max_knowledge_sources = $3`,
            [r.organization_id, FREE_AGENTS, FREE_KNOWLEDGE_SOURCES],
        );
        if (!res?.rowCount) continue;
        await audit(ACTION, r.organization_id,
            { max_agents: FREE_AGENTS, max_knowledge_sources: FREE_KNOWLEDGE_SOURCES },
            { max_agents: null, max_knowledge_sources: null });
        cleared++;
    }
    console.log(`[stale-free-limits] cleared the Free overrides of ${cleared} org(s)`);
    return { found: rows.length, cleared, orgIds };
}

/**
 * Put back what up() cleared, into columns that are still NULL.
 * @returns {Promise<{ restored: number }>}
 */
async function down() {
    const rows = await getAll(
        `SELECT DISTINCT target_id FROM subscription_audit_log WHERE action = $1 AND changed_by = $2`,
        [ACTION, CHANGED_BY],
    );
    let restored = 0;
    for (const { target_id: orgId } of rows) {
        const res = await run(
            `UPDATE organization_subscriptions
                SET max_agents = COALESCE(max_agents, $2),
                    max_knowledge_sources = COALESCE(max_knowledge_sources, $3),
                    updated_at = NOW()
              WHERE organization_id = $1 AND (max_agents IS NULL OR max_knowledge_sources IS NULL)`,
            [orgId, FREE_AGENTS, FREE_KNOWLEDGE_SOURCES],
        );
        if (!res?.rowCount) continue;
        await audit(REVERT_ACTION, orgId, null, { max_agents: FREE_AGENTS, max_knowledge_sources: FREE_KNOWLEDGE_SOURCES });
        restored++;
    }
    console.log(`[stale-free-limits] restored ${restored} org(s)`);
    return { restored };
}

module.exports = { up, down };

if (require.main === module) {
    const revert = process.argv.includes('--revert');
    const dryRun = process.argv.includes('--dry-run');
    (revert ? down() : up({ dryRun }))
        .then(() => process.exit(0))
        .catch((e) => { console.error('[stale-free-limits] failed:', e.message); process.exit(1); });
}
