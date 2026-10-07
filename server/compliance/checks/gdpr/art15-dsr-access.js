/**
 * GDPR Art. 15 — Right of access by the data subject.
 *
 * Verifies that the org has a working DSR access workflow and is fulfilling
 * requests within the one-month deadline of Art. 12(3) (or the extended
 * deadline). SLA is read from `dsr_requests`.
 */

const dsrStore = require('../../../stores/dsrStore');

module.exports = {
    id: 'GDPR-Art15-dsr-access',
    regulation: 'GDPR',
    article: '15',
    severity: 'high',
    scope: 'global',
    verification: 'automated',
    titleKey: 'compliance.checks.gdpr_art15.title',
    descriptionKey: 'compliance.checks.gdpr_art15.desc',
    remediationKey: 'compliance.checks.gdpr_art15.fix',
    remediationLink: 'admin/compliance/dsr',
    async evaluate(orgId) {
        let stats;
        try {
            stats = await dsrStore.getSlaStats(orgId, 'access', 365);
        } catch (e) {
            return {
                status: 'warn',
                // The SQLSTATE only: a driver message can quote the row it
                // failed on, and evidence is append-only.
                evidence: { error: 'dsr_ledger_unreadable', sqlstate: e?.code || null },
                details: 'Could not read DSR ledger — open Compliance → DSR Inbox to verify.',
            };
        }
        if (!stats.total) {
            return {
                status: 'not_applicable',
                evidence: stats,
                details: 'No data-subject access requests received in the last 12 months.',
            };
        }
        // Overdue and nearing both read the open requests' own `due_at`
        // (dsrStore.getSlaStats), so an extension is honoured. The average
        // fulfilment time is over CLOSED requests and says nothing about how
        // old an open one is.
        const status = stats.overdue > 0 ? 'fail' : (stats.nearing > 0 ? 'warn' : 'pass');
        return {
            status,
            evidence: stats,
            details: status === 'pass'
                ? `${stats.fulfilled}/${stats.total} access requests fulfilled (avg ${Number(stats.avg_days_to_fulfil || 0).toFixed(1)} days).`
                : status === 'warn'
                    ? `${stats.nearing} access request(s) are due within 5 days.`
                    : `${stats.overdue} access request(s) are overdue (past the one-month deadline, or the extended deadline). GDPR Art. 12(3) requires a response within one month of receipt.`,
        };
    },
};
