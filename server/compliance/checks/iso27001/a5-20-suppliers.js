/**
 * ISO 27001 A.5.20 / A.5.22 / A.5.23 — Supplier agreements, supplier
 * monitoring and cloud services.
 *
 * Suppliers are derived from observed behaviour, not a manually maintained
 * list: every external operator the workspace actually sent data to in the
 * last 30 days (integration_activity_log) is reconciled against the
 * per-operator DPA/SCC attestations in compliance settings — the same
 * reconciliation gdpr/art28-subprocessors.js performs, applied to the ISO
 * supplier controls. EU operators need coverage too; the non-EU subset is
 * surfaced separately as the cloud-services angle (A.5.23).
 */

const { getAll } = require('../../../db');
const complianceStore = require('../../../stores/complianceStore');
const { SUPPLIER_ROW } = require('../../../stores/integrationLocationSql');

module.exports = {
    id: 'ISO27001-A.5.20-suppliers',
    regulation: 'ISO27001',
    article: 'A.5.20',
    controls: ['A.5.20', 'A.5.22', 'A.5.23'],
    frameworks: [{ regulation: 'NIS2', ref: 'Art. 21(2)(d)' }, { regulation: 'DORA', ref: 'Art. 28(3)' }],
    severity: 'high',
    scope: 'global',
    verification: 'automated',
    titleKey: 'compliance.checks.iso_suppliers.title',
    descriptionKey: 'compliance.checks.iso_suppliers.desc',
    remediationKey: 'compliance.checks.iso_suppliers.fix',
    remediationLink: 'admin/compliance/ropa',
    async evaluate(orgId) {
        let operators = [];
        try {
            operators = await getAll(`
                SELECT COALESCE(operator, 'unknown') AS operator,
                       BOOL_OR(COALESCE(is_eu, false)) AS is_eu,
                       COUNT(*)::int AS calls
                FROM integration_activity_log
                WHERE organization_id = $1
                  AND timestamp >= NOW() - INTERVAL '30 days'
                  -- Not local, and not a row without operator or location:
                  -- a global network (Cloudflare, …) is a supplier and stays.
                  AND ${SUPPLIER_ROW}
                  AND COALESCE(is_dry_run, false) = false
                GROUP BY COALESCE(operator, 'unknown')
            `, [orgId]);
        } catch {
            return {
                status: 'not_applicable',
                evidence: { reason: 'activity ledger not available' },
                details: 'No outbound activity ledger yet — no suppliers observed to reconcile against agreements.',
            };
        }
        if (!operators.length) {
            return {
                status: 'not_applicable',
                evidence: { window_days: 30, operators_observed: [] },
                details: 'No outbound supplier traffic observed in the last 30 days.',
            };
        }
        const settings = await complianceStore.getSettings(orgId);
        const attested = new Set(
            (Array.isArray(settings.scc_confirmed_operators) ? settings.scc_confirmed_operators : [])
                .map(e => String(e?.operator || '').toLowerCase()).filter(Boolean)
        );
        const uncovered = operators.filter(o => !attested.has(String(o.operator).toLowerCase()));
        const nonEu = operators.filter(o => !o.is_eu);
        const evidence = {
            window_days: 30,
            operators_observed: operators,
            attested_operators: Array.from(attested),
            uncovered: uncovered.map(o => o.operator),
            non_eu_operators: nonEu.map(o => o.operator),
        };
        if (uncovered.length > 0) {
            return {
                status: 'warn',
                evidence,
                details: `${uncovered.length} of ${operators.length} observed supplier(s) (${uncovered.map(o => o.operator).join(', ')}) have no recorded agreement attestation. Every supplier that handles workspace data needs a confirmed DPA/SCC — attest them under Compliance → ROPA.`,
            };
        }
        return {
            status: 'pass',
            evidence,
            details: `All ${operators.length} supplier(s) observed in the last 30 days are covered by an attested agreement (${nonEu.length} non-EU).`,
        };
    },
};
