/**
 * ISO 27001 A.8.19 — workplace server software recorded in the evidence
 * chain. An evidence-value check: pass as soon as the Nextcloud connector
 * reports a version (the running version is then pinned and hash-chained,
 * with drift visible on every change); warn when serverinfo is unreachable
 * or silent. It never fails — a latest-release comparison is honestly out
 * of scope for this connector.
 */

const isoEvidenceStore = require('../../../stores/isoEvidenceStore');

module.exports = {
    id: 'ISO27001-A.8.19-workplace-software',
    regulation: 'ISO27001',
    article: 'A.8.19',
    controls: ['A.8.19', 'A.8.8'],
    severity: 'low',
    scope: 'global',
    verification: 'automated',
    titleKey: 'compliance.checks.iso_workplace_software.title',
    descriptionKey: 'compliance.checks.iso_workplace_software.desc',
    remediationKey: 'compliance.checks.iso_workplace_software.fix',
    remediationLink: 'admin/compliance/iso_connectors',

    async evaluate(orgId) {
        const config = await isoEvidenceStore.getConfig(orgId, 'nextcloud').catch(() => null);
        if (!config?.enabled) {
            return {
                status: 'not_applicable',
                evidence: { connector: 'nextcloud', enabled: false },
                details: 'Nextcloud connector not enabled — link an admin app password under ISO 27001 → Connectors to record the workplace server version.',
            };
        }
        const snaps = await isoEvidenceStore.listLatestSnapshots(orgId, 'nextcloud').catch(() => []);
        if (!snaps.length) {
            return {
                status: 'warn',
                evidence: { connector: 'nextcloud', enabled: true, snapshots: 0 },
                details: 'Connector enabled but no snapshot yet — serverinfo unreachable or a sweep has not run; check the base URL and app password.',
            };
        }
        const p = snaps[0].payload || {};
        const evidence = {
            version: p.version || null,
            apps_updates_available: p.apps_updates_available ?? null,
            users: p.users ?? null,
            fetched_at: snaps[0].fetched_at,
        };
        if (!p.version) {
            return {
                status: 'warn',
                evidence,
                details: 'Nextcloud serverinfo did not report a version — verify the serverinfo app is enabled and the credential is an admin.',
            };
        }
        const updates = Number(p.apps_updates_available);
        const updateNote = Number.isFinite(updates) && updates > 0
            ? ` ${updates} app update(s) pending.`
            : '';
        return {
            status: 'pass',
            evidence,
            details: `Nextcloud ${p.version} recorded in the evidence chain.${updateNote}`,
        };
    },
};
