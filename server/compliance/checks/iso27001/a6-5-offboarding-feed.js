/**
 * ISO 27001 A.6.5 — an authoritative HR feed behind joiner/leaver handling.
 * Access reviews and offboarding are only as good as the employee list they
 * run against. Pass when the AFAS GetConnector designated as the HR feed
 * answers and returns rows; warn when it is configured but empty or never
 * swept. There is no fail path — an unreachable feed surfaces as a sweep
 * error on the connector row, and an empty feed is a warning, not proof of
 * a broken leaver process.
 */

const isoEvidenceStore = require('../../../stores/isoEvidenceStore');

module.exports = {
    id: 'ISO27001-A.6.5-offboarding-feed',
    regulation: 'ISO27001',
    article: 'A.6.5',
    controls: ['A.6.1', 'A.6.5'],
    frameworks: [{ regulation: 'NIS2', ref: 'Art. 21(2)(i)' }],
    severity: 'medium',
    scope: 'global',
    verification: 'automated',
    titleKey: 'compliance.checks.iso_offboarding_feed.title',
    descriptionKey: 'compliance.checks.iso_offboarding_feed.desc',
    remediationKey: 'compliance.checks.iso_offboarding_feed.fix',
    remediationLink: 'admin/compliance/iso_connectors',

    async evaluate(orgId) {
        const config = await isoEvidenceStore.getConfig(orgId, 'afas').catch(() => null);
        if (!config?.enabled) {
            return {
                status: 'not_applicable',
                evidence: { connector: 'afas', enabled: false },
                details: 'AFAS connector not enabled — link an AppConnector token and pick your employee GetConnector under ISO 27001 → Connectors.',
            };
        }
        const snaps = await isoEvidenceStore.listLatestSnapshots(orgId, 'afas').catch(() => []);
        if (!snaps.length) {
            return {
                status: 'warn',
                evidence: { connector: 'afas', enabled: true, snapshots: 0 },
                details: 'Connector enabled but no snapshot yet — run a sweep or check the AFAS token and GetConnector settings.',
            };
        }
        const p = snaps[0].payload || {};
        const rows = Number(p.rows ?? p.employees) || 0;
        const evidence = {
            connector: p.connector || snaps[0].subject_id,
            rows,
            fields: Array.isArray(p.fields) ? p.fields.length : 0,
            fetched_at: snaps[0].fetched_at,
        };
        if (rows === 0) {
            return {
                status: 'warn',
                evidence,
                details: `HR feed "${evidence.connector}" answers but returns no rows — the population feeding access reviews is empty.`,
            };
        }
        return {
            status: 'pass',
            evidence,
            details: `HR feed "${evidence.connector}" returns ${rows} row(s) — an authoritative employee population backs joiner/leaver reviews.`,
        };
    },
};
