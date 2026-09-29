/**
 * EU AI Act Art. 4 — AI literacy (applies since 2 Feb 2025).
 *
 * Providers AND deployers must ensure a sufficient level of AI literacy in
 * the people operating AI systems on their behalf. The tool cannot verify
 * training happened — this is an annual attestation, optionally with a link
 * to the training material.
 */

const complianceStore = require('../../../stores/complianceStore');

module.exports = {
    id: 'AIA-Art4-ai-literacy',
    regulation: 'AIA',
    article: '4',
    severity: 'medium',
    scope: 'global',
    verification: 'attestation',
    titleKey: 'compliance.checks.aia_art4.title',
    descriptionKey: 'compliance.checks.aia_art4.desc',
    remediationKey: 'compliance.checks.aia_art4.fix',
    remediationLink: 'admin/compliance/settings',
    async evaluate(orgId) {
        const settings = await complianceStore.getSettings(orgId);
        const confirmedAt = settings.ai_literacy_confirmed_at ? new Date(settings.ai_literacy_confirmed_at) : null;
        const evidence = {
            confirmed_at: settings.ai_literacy_confirmed_at || null,
            material_url: settings.ai_literacy_material_url || null,
        };
        if (!confirmedAt) {
            return {
                status: 'warn',
                evidence,
                details: 'No AI-literacy attestation on record. Art. 4 (in force since Feb 2025) requires staff operating AI systems to have a sufficient level of AI literacy — confirm your training/measures under Compliance → Settings.',
            };
        }
        const ageDays = (Date.now() - confirmedAt.getTime()) / 86400000;
        if (ageDays > 365) {
            return {
                status: 'warn',
                evidence: { ...evidence, age_days: Math.round(ageDays) },
                details: `AI-literacy attestation is ${Math.round(ageDays)} days old — re-confirm annually (staff and systems change).`,
            };
        }
        return {
            status: 'pass',
            evidence: { ...evidence, age_days: Math.round(ageDays) },
            details: `AI-literacy measures attested ${Math.round(ageDays)} days ago${settings.ai_literacy_material_url ? ' (training material linked)' : ''}.`,
        };
    },
};
