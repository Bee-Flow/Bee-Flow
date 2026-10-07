'use strict';

/**
 * The processors in the RoPA (routes/compliance/ropa.js) as the outbound
 * ledger (`integration_activity_log`) saw them over the last 180 days.
 *
 * Rows flagged served_from_cache are deliberately INCLUDED. The processor
 * register asks "does this organisation use this processor, and when did it
 * last do so", and a run that acted on a stored answer is still that
 * organisation processing personal data obtained from them. Excluding cache
 * hits would let a processor drop out of an Art. 30 record entirely once a
 * cross-run hit answers every call for a day. The Art. 44 TRANSFER count is
 * the query that excludes them, because that one asks a different question:
 * did bytes actually leave.
 *
 * Local calls are no processor, and a row with neither operator nor location
 * names nobody; a global network (Cloudflare, …) is one (SUPPLIER_ROW).
 * outside_calls / via_network_calls say which processors take data out of
 * Europe, and which only through a network whose final location the
 * connection cannot see.
 *
 * The org filter is LEDGER_ORG_SQL: logToolEgress writes `organization_id`
 * NULL for a user without an organisation, and those rows belong to the
 * 'default' bucket. A plain `organization_id = $1` left a single-tenant
 * install's register without a single processor.
 */

const { getAll } = require('../../db');
const { SUPPLIER_ROW, NON_EU, LOC_STATE, LEDGER_ORG_SQL } = require('../../stores/integrationLocationSql');

const WINDOW_DAYS = 180;

const PROCESSORS_SQL = `
    SELECT operator,
           MAX(country_code) AS country_code,
           MAX(country_name) AS country_name,
           BOOL_OR(is_eu) AS is_eu,
           COUNT(*)::int AS calls,
           COUNT(*) FILTER (WHERE ${NON_EU})::int AS outside_calls,
           COUNT(*) FILTER (WHERE ${LOC_STATE} = 'via_network')::int AS via_network_calls,
           MIN(timestamp) AS first_seen,
           MAX(timestamp) AS last_seen
    FROM integration_activity_log
    WHERE ${LEDGER_ORG_SQL}
      AND timestamp >= NOW() - INTERVAL '${WINDOW_DAYS} days'
      AND ${SUPPLIER_ROW}
    GROUP BY operator
    ORDER BY calls DESC
`;

/**
 * One row per processor the org's traffic reached. Throws on a failed read;
 * the caller decides what an unreadable ledger means for its document.
 * @param {string} orgId
 */
async function ledgerProcessors(orgId) {
    return getAll(PROCESSORS_SQL, [orgId]);
}

module.exports = { ledgerProcessors, PROCESSORS_SQL, WINDOW_DAYS };
