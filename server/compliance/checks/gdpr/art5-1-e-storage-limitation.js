/**
 * GDPR Art. 5(1)(e) — Storage limitation.
 *
 * Personal data must be kept "no longer than is necessary". We check two
 * things:
 *   1. The memory retention enforcer ran in the last 24 hours (heartbeat in
 *      `compliance_settings.last_retention_run_at`).
 *   2. No `user_memories` rows are older than the org's `default_retention_days`
 *      without `expires_at` set. Orphan rows are a real risk.
 *
 * The orphan count is THIS organisation's: memories are joined to their
 * owner and counted only for the org being judged (the 'default' bucket
 * counts the memories of org-less accounts). It used to count every tenant's
 * memories on the instance and show that number to each of them.
 */

const { getOne } = require('../../../db');
const complianceStore = require('../../../stores/complianceStore');

/** A missing table or column: memories are not provisioned here yet. */
const NOT_PROVISIONED = new Set(['42P01', '42703']);

module.exports = {
    id: 'GDPR-Art5-1-e-storage-limitation',
    regulation: 'GDPR',
    article: '5(1)(e)',
    severity: 'medium',
    scope: 'global',
    verification: 'automated',
    titleKey: 'compliance.checks.gdpr_art5_1_e.title',
    descriptionKey: 'compliance.checks.gdpr_art5_1_e.desc',
    remediationKey: 'compliance.checks.gdpr_art5_1_e.fix',
    remediationLink: 'admin/compliance/settings',
    async evaluate(orgId) {
        const settings = await complianceStore.getSettings(orgId);
        const retentionDays = settings.default_retention_days || 365;
        const lastRun = settings.last_retention_run_at ? new Date(settings.last_retention_run_at) : null;
        const heartbeatAgeMs = lastRun ? Date.now() - lastRun.getTime() : Infinity;
        const heartbeatOk = heartbeatAgeMs < 26 * 3600 * 1000; // 26h allowance for clock drift

        // Orphan memories — no expires_at AND older than the retention window.
        let orphans = 0;
        let countError = null;
        try {
            const row = await getOne(`
                SELECT COUNT(*)::int AS c FROM user_memories m
                JOIN users u ON u.id = m.user_id
                WHERE m.status = 'active'
                  AND m.expires_at IS NULL
                  AND m.created_at < NOW() - ($1 || ' days')::interval
                  AND COALESCE(NULLIF(u."organizationId", ''), 'default') = $2
            `, [String(retentionDays), orgId || 'default']);
            orphans = row?.c || 0;
        } catch (e) {
            countError = e;
        }

        const evidence = {
            retention_days: retentionDays,
            heartbeat: lastRun ? settings.last_retention_run_at : null,
            heartbeat_age_hours: lastRun ? Math.round(heartbeatAgeMs / 3600000) : null,
            // null, not 0, when the count could not be read.
            orphan_memories: countError ? null : orphans,
        };

        // A broken enforcer is a finding of its own, and an unreadable memory
        // table must not hide it.
        if (!heartbeatOk) {
            return {
                status: 'fail',
                evidence,
                details: lastRun
                    ? `Memory retention enforcer last ran ${Math.round(heartbeatAgeMs / 3600000)}h ago — should run every 24h.`
                    : 'Memory retention enforcer has never run. Restart the server or enable the retention job.',
            };
        }
        if (countError) {
            // Only a missing table or column means "not provisioned yet". A
            // timeout or a dropped connection is a failed read: not_applicable
            // would drop the check out of the score and hide an orphan warning.
            if (NOT_PROVISIONED.has(countError?.code)) {
                return {
                    status: 'not_applicable',
                    evidence: { reason: 'user_memories table not available' },
                    details: 'Memory retention cannot be verified — the user_memories table is not present yet.',
                };
            }
            return {
                status: 'warn',
                // The SQLSTATE only: a driver message can quote the query.
                evidence: { reason: 'user_memories_unreadable', sqlstate: countError?.code || null },
                details: 'Stored memories could not be counted, so whether any outlive the retention window is unknown. Re-run once the database is reachable.',
            };
        }
        if (orphans > 0) {
            return {
                status: 'warn',
                evidence,
                details: `${orphans} stored memories have no retention deadline and are older than ${retentionDays} days. Run the retention enforcer or assign expires_at.`,
            };
        }
        return {
            status: 'pass',
            evidence,
            details: `Retention enforcer ran ${Math.round(heartbeatAgeMs / 3600000)}h ago; no orphan memories beyond the ${retentionDays}-day window.`,
        };
    },
};
