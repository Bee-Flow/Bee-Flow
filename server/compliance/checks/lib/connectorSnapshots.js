'use strict';

/**
 * The preamble the connector-backed ISO 27001 checks share: read the
 * connector's config, report not_applicable when it is not enabled, then read
 * its latest snapshots.
 *
 * Store errors are NOT caught here: the runner turns a thrown error into a
 * `check_exception` row (compliance/runner.js). A swallowed config read would
 * look like "connector not enabled" and a swallowed snapshot read like "no
 * snapshot yet": audit evidence that no evaluation took place.
 *
 * The store is read through its module object at call time, so tests that
 * replace isoEvidenceStore.getConfig / listLatestSnapshots reach this code.
 */

const isoEvidenceStore = require('../../../stores/isoEvidenceStore');

/**
 * @param {string} orgId
 * @param {string} connector - connector id, e.g. 'github'
 * @param {string} notEnabledDetails - the check's own "not enabled" text
 * @returns {Promise<{result: object} | {config: any, snaps: any[]}>}
 *   `result` is the not_applicable answer to return as is.
 */
async function readConnectorSnapshots(orgId, connector, notEnabledDetails) {
    const config = await isoEvidenceStore.getConfig(orgId, connector);
    if (!config?.enabled) {
        return {
            result: {
                status: 'not_applicable',
                evidence: { connector, enabled: false },
                details: notEnabledDetails,
            },
        };
    }
    const snaps = await isoEvidenceStore.listLatestSnapshots(orgId, connector);
    return { config, snaps };
}

/** The warn for an enabled connector without usable snapshots; `counts` defaults to `{ snapshots: 0 }`. */
function noSnapshotYet(connector, details, counts = { snapshots: 0 }) {
    return {
        status: 'warn',
        evidence: { connector, enabled: true, ...counts },
        details,
    };
}

module.exports = { readConnectorSnapshots, noSnapshotYet };
