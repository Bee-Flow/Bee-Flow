// @typecheck strict
'use strict';

/**
 * The compliance module's part of the operational metric rollups (stores/metricsStore.js asks
 * for it by name): how long ago each organisation's retention sweep ran. Keyed by org only.
 */

/** @typedef {(sql: string, params?: unknown[]) => Promise<any[]>} GetAll */

/**
 * GDPR retention-job liveness — seconds since the last enforced sweep per
 * org: rows `{ org_id, value }`. A large/growing value means the
 * memoryRetentionEnforcer stopped.
 * @param {GetAll} getAll
 */
function retentionRunAge(getAll) {
    return getAll(`
        SELECT organization_id AS org_id,
               EXTRACT(EPOCH FROM (NOW() - last_retention_run_at))::int AS value
          FROM compliance_settings
         WHERE last_retention_run_at IS NOT NULL`);
}

module.exports = { retentionRunAge };
