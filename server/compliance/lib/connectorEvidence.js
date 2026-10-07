'use strict';

/**
 * What the ISO connector checks share when they read the evidence store.
 *
 * READ FAILURES. isoEvidenceStore.getConfig and listLatestSnapshots both run
 * the store's initDB first, so a throw is a read that FAILED, never a fresh
 * install. Reporting it as "connector not enabled" (not_applicable, which
 * leaves the score) or as "no snapshot yet" hides the failure, so the check
 * warns that the control was not assessed this run. Only the SQLSTATE travels
 * into the evidence: a driver message can quote query values.
 *
 * THE CONFIGURED SUBJECT. listLatestSnapshots returns the latest snapshot per
 * subject, ordered by subject_id, and a subject's rows stay after the setting
 * that produced them changes (a new domain, project or GetConnector). A check
 * that judged the first row could judge the stale subject, so it picks the row
 * whose subject_id is the configured one, normalised exactly as the connector
 * normalises it before using it as the subject.
 */

/** The warn a check returns when the connector config or snapshots could not be read. */
function unreadableConnector(connectorId, e) {
    const code = e?.code || null;
    return {
        status: 'warn',
        evidence: { connector: connectorId, readable: false, error_code: code },
        details: `The ${connectorId} connector configuration or its snapshots could not be read${code ? ` (SQL state ${code})` : ''}, so this control was not assessed this run.`,
    };
}

/**
 * Read one connector's config and, when it is enabled, its latest snapshots.
 * @returns {Promise<{config: any, snaps: any[]} | {failed: object}>}
 */
async function readConnector(store, orgId, connectorId) {
    try {
        const config = await store.getConfig(orgId, connectorId);
        if (!config?.enabled) return { config, snaps: [] };
        const snaps = await store.listLatestSnapshots(orgId, connectorId);
        return { config, snaps: Array.isArray(snaps) ? snaps : [] };
    } catch (e) {
        return { failed: unreadableConnector(connectorId, e) };
    }
}

/** The latest snapshot of the configured subject among listLatestSnapshots' rows, or null. */
function snapshotFor(snaps, subjectId) {
    if (!subjectId) return null;
    return (snaps || []).find(s => String(s?.subject_id ?? '') === subjectId) || null;
}

module.exports = { unreadableConnector, readConnector, snapshotFor };
