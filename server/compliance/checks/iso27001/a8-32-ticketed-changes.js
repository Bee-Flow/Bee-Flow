// @typecheck noImplicitAny
/**
 * ISO 27001 A.8.32 — changes demonstrably run through tickets. Reads the
 * YouTrack connector snapshot: issue activity in the designated operations
 * project over the last 30 days. Pass on any activity, warn on none — a
 * silent project leaves no change trail. Distinct from the repository-side
 * change check (a8-32-change-management can coexist): this one covers the
 * operational/ticket side.
 */

const { readConnectorSnapshots, noSnapshotYet } = require('../lib/connectorSnapshots');
const { snapshotFor } = require('../../lib/connectorEvidence');

module.exports = {
    id: 'ISO27001-A.8.32-ticketed-changes',
    regulation: 'ISO27001',
    article: 'A.8.32',
    controls: ['A.8.32'],
    severity: 'low',
    scope: 'global',
    verification: 'automated',
    titleKey: 'compliance.checks.iso_ticketed_changes.title',
    descriptionKey: 'compliance.checks.iso_ticketed_changes.desc',
    remediationKey: 'compliance.checks.iso_ticketed_changes.fix',
    remediationLink: 'admin/compliance/iso_connectors',

    /**
     * @param {string} orgId
     */
    async evaluate(orgId) {
        const read = await readConnectorSnapshots(orgId, 'youtrack', 'YouTrack connector not enabled — link a permanent token and set the operations project under ISO 27001 → Connectors.');
        if (read.result) return read.result;
        const { config, snaps } = read;
        // The project as the connector trims it into the subject; a project
        // that was configured before keeps its last snapshot in the list.
        const snap = snapshotFor(snaps, String(config.settings?.project || '').trim());
        if (!snap) return noSnapshotYet('youtrack', 'Connector enabled but no snapshot for the configured project yet — run a sweep or check the base URL, token and project.');
        const p = snap.payload || {};
        const recent = Number(p.recent_issues) || 0;
        const resolved = Number(p.resolved_recent) || 0;
        const evidence = {
            project: p.project || snap.subject_id,
            window_days: p.window_days || 30,
            recent_issues: recent,
            resolved_recent: resolved,
            fetched_at: snap.fetched_at,
        };
        if (recent === 0) {
            return {
                status: 'warn',
                evidence,
                details: `No issues updated in project "${evidence.project}" in the last ${evidence.window_days} days — no visible ticket trail for changes.`,
            };
        }
        return {
            status: 'pass',
            evidence,
            details: `${recent} issue(s) updated (${resolved} resolved) in project "${evidence.project}" over the last ${evidence.window_days} days — change work is tracked in tickets.`,
        };
    },
};
