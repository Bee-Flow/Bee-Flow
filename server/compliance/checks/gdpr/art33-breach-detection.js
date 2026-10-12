/**
 * GDPR Art. 33 — Breach notification readiness AND live 72-hour compliance.
 *
 * Two signals, hence verification: 'hybrid':
 *   1. Attestation — at least one breach-notification recipient is configured
 *      (compliance_settings.breach_recipients).
 *   2. Automated — the incident registry (compliance_incidents): any OPEN
 *      incident past its 72-hour deadline without a recorded authority
 *      notification is a live Art. 33 violation → fail; one within 24 hours of
 *      the deadline → warn. The 72 hours run from detected_at and count only
 *      incidents under the GDPR regime (incidentStore's gdpr_* counts), never
 *      `deadline_at`: that is the earliest clock over every regime, a NIS2 or
 *      CRA 24 h early warning or a DORA customer notice included.
 *
 * A registry that cannot be read is not "no incidents": only a table that is
 * not there yet (SQLSTATE 42P01/42703) leaves the readiness signal alone; any
 * other failure warns with the SQLSTATE, because whether an incident is past
 * its deadline is then unknown.
 */

const complianceStore = require('../../../stores/complianceStore');
const incidentStore = require('../../../stores/incidentStore');

// Undefined table / column: the registry is not provisioned on this install.
const NOT_PROVISIONED = new Set(['42P01', '42703']);

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
        let registryError = null;
        try {
            deadlines = await incidentStore.getDeadlineStats(orgId);
        } catch (e) {
            // Not provisioned: readiness signal only. Anything else: unknown.
            if (!NOT_PROVISIONED.has(e?.code)) registryError = e?.code || 'unknown';
        }
        // The Art. 33 clock only; the roll-up is a fallback for a store (or a
        // stub) that does not report the GDPR counts.
        const overdue = deadlines.gdpr_overdue_unnotified ?? deadlines.overdue_unnotified;
        const nearing = deadlines.gdpr_nearing_deadline ?? deadlines.nearing_deadline;

        const evidence = {
            breach_recipients_count: validRecipients.length,
            open_incidents: deadlines.open,
            overdue_unnotified: overdue,
            nearing_deadline: nearing,
        };

        if (validRecipients.length === 0) {
            return {
                status: 'fail',
                evidence,
                details: 'No breach-notification recipients are set. GDPR Art. 33 requires notification within 72 hours — add at least one email.',
            };
        }
        if (registryError) {
            return {
                status: 'warn',
                evidence: { breach_recipients_count: validRecipients.length, registry_readable: false, sqlstate: registryError },
                details: 'The incident registry could not be read, so whether an open incident is past its 72-hour Art. 33 deadline is unknown. Re-run once the database is reachable.',
            };
        }
        if (overdue > 0) {
            return {
                status: 'fail',
                evidence,
                details: `${overdue} open incident(s) are past the 72-hour Art. 33 deadline without a recorded authority notification. Record the notification (or close the incident with an assessment) now.`,
            };
        }
        if (nearing > 0) {
            return {
                status: 'warn',
                evidence,
                details: `${nearing} open incident(s) reach the 72-hour Art. 33 deadline within 24 hours.`,
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
