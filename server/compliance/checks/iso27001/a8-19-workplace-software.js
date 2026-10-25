// @typecheck noImplicitAny
/**
 * ISO 27001 A.8.19 — workplace server software recorded in the evidence
 * chain. An evidence-value check: pass as soon as the Nextcloud connector
 * reports a version (the running version is then pinned and hash-chained,
 * with drift visible on every change); warn when serverinfo is unreachable
 * or silent. It never fails — a latest-release comparison is honestly out
 * of scope for this connector.
 */

const { readConnectorSnapshots, noSnapshotYet } = require('../lib/connectorSnapshots');

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

    /**
     * @param {string} orgId
     */
    async evaluate(orgId) {
        const read = await readConnectorSnapshots(orgId, 'nextcloud', 'Nextcloud connector not enabled — link an admin app password under ISO 27001 → Connectors to record the workplace server version.');
        if (read.result) return read.result;
        const { snaps } = read;
        if (!snaps.length) return noSnapshotYet('nextcloud', 'Connector enabled but no snapshot yet — serverinfo unreachable or a sweep has not run; check the base URL and app password.');
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
