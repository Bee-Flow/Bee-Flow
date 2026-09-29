/**
 * GDPR Art. 33 — Breach notification readiness AND live 72-hour compliance.
 *
 * Two signals, hence verification: 'hybrid':
 *   1. Attestation — at least one breach-notification recipient is configured
 *      (compliance_settings.breach_recipients).
 *   2. Automated — the incident registry (compliance_incidents): any OPEN
 *      incident past its 72-hour deadline without a recorded authority
 *      notification is a live Art. 33 violation → fail; one within 24 hours of
 *      the deadline → warn.
 */

const complianceStore = require('../../../stores/complianceStore');
const incidentStore = require('../../../stores/incidentStore');

module.exports = {
    id: 'GDPR-Art33-breach-detection',
    regulation: 'GDPR',
    article: '33',
    // Also ISO 27001 evidence (control A.5.24) — counts once per framework.
    frameworks: [{ regulation: 'ISO27001', ref: 'A.5.24' }],
    severity: 'high',
    scope: 'global',
    verification: 'hybrid',
    titleKey: 'compliance.checks.gdpr_art33.title',
    descriptionKey: 'compliance.checks.gdpr_art33.desc',
    remediationKey: 'compliance.checks.gdpr_art33.fix',
    remediationLink: 'admin/compliance/incidents',
    async evaluate(orgId) {
        const settings = await complianceStore.getSettings(orgId);
        const recipients = Array.isArray(settings.breach_recipients) ? settings.breach_recipients : [];
        const validRecipients = recipients.filter(r => typeof r === 'string' && /@/.test(r));

        let deadlines = { open: 0, overdue_unnotified: 0, nearing_deadline: 0 };
        try {
            deadlines = await incidentStore.getDeadlineStats(orgId);
        } catch { /* fresh install without the table — readiness signal only */ }

        const evidence = {
            breach_recipients_count: validRecipients.length,
            open_incidents: deadlines.open,
            overdue_unnotified: deadlines.overdue_unnotified,
            nearing_deadline: deadlines.nearing_deadline,
        };

        if (validRecipients.length === 0) {
            return {
                status: 'fail',
                evidence,
                details: 'No breach-notification recipients are set. GDPR Art. 33 requires notification within 72 hours — add at least one email.',
            };
        }
        if (deadlines.overdue_unnotified > 0) {
            return {
                status: 'fail',
                evidence,
                details: `${deadlines.overdue_unnotified} open incident(s) are past the 72-hour Art. 33 deadline without a recorded authority notification. Record the notification (or close the incident with an assessment) now.`,
            };
        }
        if (deadlines.nearing_deadline > 0) {
            return {
                status: 'warn',
                evidence,
                details: `${deadlines.nearing_deadline} open incident(s) reach the 72-hour Art. 33 deadline within 24 hours.`,
            };
        }
        return {
            status: 'pass',
            evidence,
            details: deadlines.open > 0
                ? `${validRecipients.length} recipient(s) configured; ${deadlines.open} open incident(s), all within the 72-hour window.`
                : `${validRecipients.length} breach-notification recipient(s) configured. The 72-hour window can be met.`,
        };
    },
};
