/**
 * ISO 27001 A.5.24 / A.5.25 / A.5.26 — Incident management: preparation,
 * assessment and response.
 *
 * The incident register (compliance_incidents) is the working proof that an
 * incident process exists: events are recorded, carry a notification
 * deadline, and progress through assessment to closure. Signals:
 *   1. PREPARATION — at least one notification recipient is configured, so
 *      alerts have somewhere to go before anything happens.
 *   2. RESPONSE — no open incident sits past its notification deadline
 *      without a recorded authority notification (fail); one within 24 hours
 *      of the deadline degrades to warn.
 *
 * Same registry as gdpr/art33-breach-detection.js, wider framing: this check
 * evidences the management process, not just the GDPR 72-hour clock.
 */

const complianceStore = require('../../../stores/complianceStore');
const incidentStore = require('../../../stores/incidentStore');

module.exports = {
    id: 'ISO27001-A.5.24-incident-mgmt',
    regulation: 'ISO27001',
    article: 'A.5.24',
    controls: ['A.5.24', 'A.5.25', 'A.5.26'],
    frameworks: [{ regulation: 'NIS2', ref: 'Art. 21(2)(b)' }, { regulation: 'NIS2', ref: 'Art. 23' }, { regulation: 'GDPR', ref: 'Art. 33' }, { regulation: 'CRA', ref: 'Art. 14' }, { regulation: 'DORA', ref: 'Art. 30' }],
    severity: 'high',
    scope: 'global',
    verification: 'automated',
    titleKey: 'compliance.checks.iso_incident_mgmt.title',
    descriptionKey: 'compliance.checks.iso_incident_mgmt.desc',
    remediationKey: 'compliance.checks.iso_incident_mgmt.fix',
    remediationLink: 'admin/compliance/incidents',
    async evaluate(orgId) {
        const settings = await complianceStore.getSettings(orgId);
        const recipients = Array.isArray(settings.breach_recipients) ? settings.breach_recipients : [];
        const validRecipients = recipients.filter(r => typeof r === 'string' && /@/.test(r));

        let deadlines = { open: 0, overdue_unnotified: 0, nearing_deadline: 0 };
        let registryReachable = true;
        try {
            deadlines = await incidentStore.getDeadlineStats(orgId);
        } catch {
            // getDeadlineStats runs incidentStore.initDB first, so a throw is a
            // failed read, never a fresh install without the table.
            registryReachable = false;
        }

        // Evidence enrichment only — status never depends on this list, so a
        // failed read leaves the sample empty.
        let attention = [];
        try {
            attention = await incidentStore.listNeedingAttention(orgId) || [];
        } catch { /* sample stays empty */ }

        const evidence = {
            recipients_count: validRecipients.length,
            open_incidents: deadlines.open || 0,
            overdue_unnotified: deadlines.overdue_unnotified || 0,
            nearing_deadline: deadlines.nearing_deadline || 0,
            registry_reachable: registryReachable,
            attention_sample: attention.slice(0, 10).map(i => ({
                id: i.id, severity: i.severity, status: i.status, deadline_at: i.deadline_at,
            })),
        };

        // Unknown deadlines are never "no incident is stuck past a deadline".
        if (!registryReachable) {
            return {
                status: 'warn',
                evidence,
                details: 'The incident register could not be read, so whether an incident is past its deadline is unknown for this run.',
            };
        }

        if ((deadlines.overdue_unnotified || 0) > 0) {
            return {
                status: 'fail',
                evidence,
                details: `${deadlines.overdue_unnotified} open incident(s) are past their notification deadline without a recorded authority notification. The response step of the incident process is not being executed — record the notification, or close the incident with an assessment.`,
            };
        }

        const warnings = [];
        if (validRecipients.length === 0) {
            warnings.push('No incident-notification recipients are configured, so nobody is alerted when an incident is registered or a deadline approaches.');
        }
        if ((deadlines.nearing_deadline || 0) > 0) {
            warnings.push(`${deadlines.nearing_deadline} open incident(s) reach their notification deadline within 24 hours.`);
        }
        if (warnings.length > 0) {
            return { status: 'warn', evidence, details: warnings.join(' ') };
        }

        return {
            status: 'pass',
            evidence,
            details: (deadlines.open || 0) > 0
                ? `Incident process operational: ${validRecipients.length} recipient(s) configured and ${deadlines.open} open incident(s), all inside their notification window.`
                : `Incident process ready: ${validRecipients.length} notification recipient(s) configured and no incident is stuck past a deadline.`,
        };
    },
};
