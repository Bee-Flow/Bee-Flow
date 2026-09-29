/**
 * GDPR Art. 28 — processor contracts (DPAs).
 *
 * Every processor that touches personal data on the org's behalf needs a
 * binding processing agreement. Automated signal: operators observed in the
 * outbound activity ledger over the last 30 days vs the per-operator SCC/DPA
 * attestation list. Complements Art. 44 (which FAILS only on unattested
 * NON-EU transfers) — Art. 28 covers EU processors too, so an unattested EU
 * operator still warns here.
 *
 * The ledger query lives in lib/observedOperators.js (fromActivityLog) so the
 * DORA register of information (Art. 28(3)) reconciles against the very same
 * numbers; the status logic here is unchanged. The same evidence also counts
 * for ISO 27001 A.5.20 (supplier agreements), NIS2 Art. 21(2)(d) (supply-chain
 * security) and DORA Art. 28(3).
 */

const complianceStore = require('../../../stores/complianceStore');
const observedOperators = require('../../lib/observedOperators');

module.exports = {
    id: 'GDPR-Art28-subprocessors',
    regulation: 'GDPR',
    article: '28',
    frameworks: [
        { regulation: 'ISO27001', ref: 'A.5.20' },
        { regulation: 'NIS2', ref: 'Art. 21(2)(d)' },
        { regulation: 'DORA', ref: 'Art. 28(3)' },
    ],
    severity: 'medium',
    scope: 'global',
    verification: 'automated',
    titleKey: 'compliance.checks.gdpr_art28.title',
    descriptionKey: 'compliance.checks.gdpr_art28.desc',
    remediationKey: 'compliance.checks.gdpr_art28.fix',
    remediationLink: 'admin/compliance/ropa',
    async evaluate(orgId) {
        const operators = await observedOperators.fromActivityLog(orgId);
        if (operators === null) {
            return {
                status: 'not_applicable',
                evidence: { reason: 'activity ledger not available' },
                details: 'No outbound activity ledger yet — nothing to reconcile against processor agreements.',
            };
        }
        if (!operators.length) {
            return {
                status: 'not_applicable',
                evidence: { operators: [] },
                details: 'No outbound processor traffic observed in the last 30 days.',
            };
        }
        const settings = await complianceStore.getSettings(orgId);
        const attested = new Set(
            (Array.isArray(settings.scc_confirmed_operators) ? settings.scc_confirmed_operators : [])
                .map(e => String(e?.operator || '').toLowerCase()).filter(Boolean)
        );
        const uncovered = operators.filter(o => !attested.has(String(o.operator).toLowerCase()));
        const evidence = {
            window_days: observedOperators.WINDOW_DAYS,
            operators_observed: operators,
            attested_operators: Array.from(attested),
            uncovered: uncovered.map(o => o.operator),
        };
        if (uncovered.length > 0) {
            return {
                status: 'warn',
                evidence,
                details: `${uncovered.length} observed processor(s) (${uncovered.map(o => o.operator).join(', ')}) have no recorded DPA/SCC attestation. Art. 28 requires a processing agreement with every processor — confirm them under Compliance → ROPA.`,
            };
        }
        return {
            status: 'pass',
            evidence,
            details: `All ${operators.length} observed processor(s) in the last 30 days are covered by an attested agreement.`,
        };
    },
};
