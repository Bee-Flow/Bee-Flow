// @typecheck
/**
 * SQL fragments for the outbound-call ledger (integration_activity_log).
 *
 * One place for the expressions every reader must agree on: the destination
 * key, "carried personal data", and above all the LOCATION of a row. Since
 * the location rework every new row carries `location_state`:
 *   local | eu | outside | via_network | unknown
 * Rows written before it have NULL there until the detached backfill
 * (integrationActivitySchema.js) reaches them, and a replica still running
 * the old code can add more during a rolling deploy. LEGACY_STATE_CASE is the
 * state such a row gets, used both by the backfill and as the read-side
 * fallback in LOC_STATE, so a query never depends on how far the backfill got.
 *
 * Order in LEGACY_STATE_CASE matters:
 *   1. a private peer address, the row's is_local flag, or the
 *      endpoint label 'local' (in-app notifications)              → local
 *   2. an anycast operator (Cloudflare, Fastly, OpenAI, Akamai) → via_network
 *      BEFORE is_eu: ip-api.com placed Cloudflare's anycast in NL for some
 *      prefixes and in CA for others, so the old is_eu said nothing there
 *   3. is_eu                                                      → eu
 *   4. a country                                                  → outside
 *   5. otherwise                                                  → unknown
 *
 * No `::inet` cast in the private-address test: one malformed value in a
 * historical row would make the whole statement fail.
 */

'use strict';

/** Destination grouping key. New rows carry dest_host; the COALESCE keeps legacy rows in one bucket. */
const DEST_EXPR = `COALESCE(NULLIF(dest_host, ''), lower(COALESCE(NULLIF(tls_servername, ''), server_endpoint)))`;

const HAS_PII = `pii_categories_detected IS NOT NULL AND pii_categories_detected != ''`;

// Private, loopback, link-local, CGNAT (100.64/10, Kapsule pods), unique-local
// IPv6 and IPv4-mapped forms of all of those. Mirrors core/http/ipClass.js.
const PRIVATE_V4 = String.raw`(10\.|127\.|0\.|192\.168\.|169\.254\.|172\.(1[6-9]|2[0-9]|3[01])\.|100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.)`;
const PRIVATE_IP_RE = String.raw`^(${PRIVATE_V4}|::1$|::$|f[cd][0-9a-f]{0,2}:|fe[89ab][0-9a-f]:|::ffff:${PRIVATE_V4})`;

/** The address a legacy row recorded (server_ip is the retired duplicate). */
const ROW_IP = `COALESCE(peer_ip, server_ip)`;

/** A private peer address, as a boolean expression. */
const IS_PRIVATE_PEER = `COALESCE(${ROW_IP} ~* '${PRIVATE_IP_RE}', false)`;

/** Operators whose addresses are anycast edges (the pre-ASN operator labels). */
const ANYCAST_OPERATORS = ['Cloudflare', 'Fastly', 'OpenAI', 'Akamai'];

const LEGACY_STATE_CASE = `CASE
            WHEN COALESCE(is_local, false) OR ${IS_PRIVATE_PEER}
                 OR lower(trim(server_endpoint)) IN ('local', 'localhost') THEN 'local'
            WHEN operator IN (${ANYCAST_OPERATORS.map(o => `'${o}'`).join(', ')}) THEN 'via_network'
            WHEN COALESCE(is_eu, false) THEN 'eu'
            WHEN NULLIF(country_code, '') IS NOT NULL THEN 'outside'
            ELSE 'unknown'
        END`;

/** The location state of a row, new or old. */
const LOC_STATE = `COALESCE(location_state, ${LEGACY_STATE_CASE})`;

/** How the location was determined; 'backfill' for a row from before the rework. */
const LOC_BASIS = `COALESCE(location_basis, 'backfill')`;

/**
 * Data that left Europe. The first two conditions are the predicate of the
 * partial index idx_integ_org_ts_noneu, so a filtered query can still use it;
 * the third excludes what is not a known transfer (via a global network,
 * or no location).
 */
const NON_EU = `is_eu = false AND is_local = false AND ${LOC_STATE} = 'outside'`;

/** Counted in the sovereignty score: a location we actually know. */
const LOCATED = `${LOC_STATE} IN ('local', 'eu', 'outside')`;

/**
 * A row that can name a supplier, for the processor and supplier registers
 * (Art-28/30, ISO A.5.20, DORA 28(3)): nothing local (nothing left the
 * building), and no row that has neither an operator nor a location (it names
 * nobody). A call via a global network stays: that network is a supplier.
 * Deliberately free of country_code: the Art-28 query does not read it.
 */
const SUPPLIER_ROW = `COALESCE(is_local, false) = false
              AND NOT ${IS_PRIVATE_PEER}
              AND NOT (operator IS NULL AND COALESCE(location_state,
                    CASE WHEN COALESCE(is_eu, false) OR ${ROW_IP} IS NOT NULL THEN 'located' ELSE 'unknown' END) = 'unknown')`;

/**
 * The org filter for the ledger, with `$1` the org id.
 *
 * logToolEgress writes `organization_id` NULL for a user with no organisation,
 * which on a single-tenant install is every user — while the scheduler sweeps
 * that install as the 'default' bucket. A plain `organization_id = $1` meant
 * 'default' never saw its own traffic. The NULL/'' rows count for 'default'
 * only, never for a real org, and the comparisons stay on the bare column so
 * the org index is still usable. Defined here, beside the other ledger
 * fragments, so a reader needs no database module to import it; compliance/
 * lib/observedOperators.js re-exports it under the same name.
 */
const LEDGER_ORG_SQL = "(organization_id = $1 OR ($1::text = 'default' AND (organization_id IS NULL OR organization_id = '')))";

/** `COUNT(*) FILTER (WHERE <state>)` for each state, named <state>_count. */
function stateCounts(prefix = '') {
    return ['local', 'eu', 'via_network', 'unknown']
        .map(s => `COUNT(*) FILTER (WHERE ${LOC_STATE} = '${s}') AS ${prefix}${s}_count`)
        .join(',\n                ');
}

module.exports = {
    DEST_EXPR,
    HAS_PII,
    PRIVATE_IP_RE,
    IS_PRIVATE_PEER,
    ANYCAST_OPERATORS,
    LEGACY_STATE_CASE,
    LOC_STATE,
    LOC_BASIS,
    NON_EU,
    LOCATED,
    SUPPLIER_ROW,
    LEDGER_ORG_SQL,
    stateCounts,
};
