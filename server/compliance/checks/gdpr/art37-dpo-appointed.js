/**
 * GDPR Art. 37 — Data Protection Officer appointed.
 * Reads compliance_settings.dpo_name and dpo_email; records only THAT they are
 * set, never their values.
 */

const complianceStore = require('../../../stores/complianceStore');

module.exports = {
    id: 'GDPR-Art37-dpo-appointed',
    regulation: 'GDPR',
    article: '37',
    severity: 'high',
    scope: 'global',
    verification: 'attestation',
    titleKey: 'compliance.checks.gdpr_art37.title',
    descriptionKey: 'compliance.checks.gdpr_art37.desc',
    remediationKey: 'compliance.checks.gdpr_art37.fix',
    remediationLink: 'admin/compliance/settings',
    async evaluate(orgId) {
        const s = await complianceStore.getSettings(orgId);
        const hasEmail = !!(s.dpo_email && /@/.test(s.dpo_email));
        const hasName = !!s.dpo_name;
        let status;
        if (hasEmail && hasName) status = 'pass';
        else if (hasEmail || hasName) status = 'warn';
        else status = 'fail';
        return {
            status,
            evidence: { dpo_name: !!hasName, dpo_email: !!hasEmail },
            details: status === 'pass'
                // Never the name or address itself: details are written into the
                // append-only evidence chain on every sweep, and a chain cannot
                // forget a person who leaves the role.
                ? 'A Data Protection Officer is appointed, with a name and e-mail address on record (Compliance → Settings).'
                : status === 'warn'
                    ? 'DPO details are incomplete. Fill in both name and a valid email.'
                    : 'No Data Protection Officer has been appointed. Required when processing personal data at scale.',
        };
    },
};
