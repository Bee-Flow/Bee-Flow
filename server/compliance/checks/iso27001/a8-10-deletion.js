/**
 * ISO 27001 A.8.10 — Information deletion.
 *
 * Two signals:
 *   1. The memory retention enforcer heartbeat
 *      (compliance_settings.last_retention_run_at) — 26 h allowance, the same
 *      threshold as the GDPR Art. 5(1)(e) check so the two never disagree.
 *   2. Erasure-request fulfilment from the DSR ledger: an overdue deletion
 *      request means data marked for erasure is demonstrably still present.
 */

const complianceStore = require('../../../stores/complianceStore');
const dsrStore = require('../../../stores/dsrStore');

module.exports = {
    id: 'ISO27001-A.8.10-deletion',
    regulation: 'ISO27001',
    article: 'A.8.10',
    controls: ['A.8.10'],
    severity: 'medium',
    scope: 'global',
    verification: 'automated',
    titleKey: 'compliance.checks.iso_deletion.title',
    descriptionKey: 'compliance.checks.iso_deletion.desc',
    remediationKey: 'compliance.checks.iso_deletion.fix',
    remediationLink: 'admin/compliance/settings',
    async evaluate(orgId) {
        const settings = await complianceStore.getSettings(orgId);
        const lastRun = settings.last_retention_run_at ? new Date(settings.last_retention_run_at) : null;
        const heartbeatAgeMs = lastRun ? Date.now() - lastRun.getTime() : Infinity;
        const heartbeatOk = heartbeatAgeMs < 26 * 3600 * 1000; // 26h allowance for clock drift

        let stats = null;
        let ledgerError = null;
        try {
            stats = await dsrStore.getSlaStats(orgId, 'deletion', 365);
        } catch (e) {
            ledgerError = e.message;
        }

        const evidence = {
            heartbeat: lastRun ? settings.last_retention_run_at : null,
            heartbeat_age_hours: lastRun ? Math.round(heartbeatAgeMs / 3600000) : null,
            deletion_requests_total: stats ? stats.total : null,
            deletion_requests_open: stats ? stats.open : null,
            deletion_requests_overdue: stats ? stats.overdue : null,
            deletion_requests_fulfilled: stats ? stats.fulfilled : null,
            dsr_ledger_error: ledgerError || undefined,
        };

        if (!heartbeatOk) {
            return {
                status: 'fail',
                evidence,
                details: lastRun
                    ? `The retention enforcer last ran ${Math.round(heartbeatAgeMs / 3600000)}h ago — automated deletion is not running on its 24h schedule.`
                    : 'The retention enforcer has never run — expired data is not being deleted automatically. Restart the server or enable the retention job.',
            };
        }
        if (stats && stats.overdue > 0) {
            return {
                status: 'fail',
                evidence,
                details: `${stats.overdue} deletion request(s) are past the 30-day deadline — data marked for erasure is still present.`,
            };
        }
        if (ledgerError) {
            return {
                status: 'warn',
                evidence,
                details: 'Retention enforcement is running, but the DSR ledger could not be read — deletion-request fulfilment is unverified. Open Compliance → DSR Inbox to check.',
            };
        }
        const fulfilNote = stats.total > 0
            ? `${stats.fulfilled}/${stats.total} deletion request(s) fulfilled, ${stats.open} open, none overdue.`
            : 'No deletion requests received in the last 12 months.';
        return {
            status: 'pass',
            evidence,
            details: `Retention enforcer ran ${Math.round(heartbeatAgeMs / 3600000)}h ago. ${fulfilNote}`,
        };
    },
};
