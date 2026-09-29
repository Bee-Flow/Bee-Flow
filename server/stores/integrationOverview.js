// @typecheck
/**
 * The consolidated Activity overview of the outbound-call ledger: everything
 * the Privacy Shield "Activity" tab needs in one response. Reached through
 * integrationActivityStore.getIntegrationOverview, which runs the store's
 * init first and passes its filter builder in.
 *
 * Location rules (integrationLocationSql.js):
 *   - "left Europe" (non_eu_count, the Art-44 view) counts only `outside`;
 *     a call via a global network or without a known location is neither in
 *     nor out, and has its own count (via_network_count, unknown_count);
 *   - the sovereignty score is computed over LOCATED calls only
 *     (local + eu + outside), with coverage_pct saying how many that is;
 *   - a destination has ONE location: the most frequent (state, city, point,
 *     country, edge) combination of that host in the window. Taking mode()
 *     per column mixed the city of one location with the point of another.
 */

'use strict';

const { getOne, getAll } = require('../db');
const { DEST_EXPR, HAS_PII, NON_EU, LOC_STATE, LOC_BASIS, LOCATED, stateCounts } = require('./integrationLocationSql');
const geo = require('./serverGeoResolver');

const TOP_DESTINATIONS = 12;
const MAP_DESTINATIONS = 200;

/** Roll rows up by canonical category id (merges legacy-label rows). */
function _rollupByCategory(rows, keyField, normalizeCategory) {
    const normalize = normalizeCategory || ((c) => String(c || '').trim() || null);
    const merged = new Map();
    for (const row of rows || []) {
        const id = normalize(row[keyField]);
        if (!id) continue;
        const cur = merged.get(id) || { category: id, count: 0, non_eu_count: 0 };
        cur.count += Number(row.count) || 0;
        cur.non_eu_count += Number(row.non_eu_count) || 0;
        merged.set(id, cur);
    }
    return [...merged.values()].sort((a, b) => b.count - a.count);
}

/** 100 × (1 − (outside + pii-outside) / (located + pii-outside)); pii to outside costs double. */
function sovereigntyScore(outside, piiOutside, located) {
    if (!(located > 0)) return null;
    return Math.max(0, Math.min(100, Math.round(100 * (1 - (outside + piiOutside) / (located + piiOutside)))));
}

const _num = (v) => (v === null || v === undefined ? null : Number(v));

/** A destination row, in the shape of the API contract. */
function _destination(r) {
    return {
        dest_host: r.dest_host,
        operator: r.operator || null,
        as_org: r.as_org || null,
        network: r.network || null,
        country_code: r.country_code || null,
        country_name: r.country_name || (r.country_code ? geo.countryName(r.country_code) : null),
        city: r.city || null,
        lat: _num(r.lat),
        lon: _num(r.lon),
        location_state: r.location_state,
        location_basis: r.location_basis,
        edge_pop: r.edge_pop || null,
        is_eu: r.location_state === 'eu',
        is_local: r.location_state === 'local',
        total: Number(r.total) || 0,
        pii_events: Number(r.pii_events) || 0,
        last_contact: r.last_contact || null,
        sample_peer_ip: r.sample_peer_ip || null,
        country_flag: geo.countryFlag(r.country_code),
    };
}

function _destinationsSql(and) {
    return `
        WITH base AS (
            SELECT ${DEST_EXPR} AS dest_host, ${LOC_STATE} AS location_state, ${LOC_BASIS} AS location_basis,
                   city, lat, lon, country_code, country_name, edge_pop, network, as_org, operator,
                   COALESCE(peer_ip, server_ip) AS ip, (${HAS_PII}) AS has_pii, timestamp
            FROM integration_activity_log ${and} ${DEST_EXPR} IS NOT NULL
        ),
        tuples AS (
            SELECT dest_host, location_state, city, lat, lon, country_code, edge_pop,
                   ROW_NUMBER() OVER (PARTITION BY dest_host ORDER BY COUNT(*) DESC, MAX(timestamp) DESC) AS rk,
                   mode() WITHIN GROUP (ORDER BY country_name) AS country_name,
                   mode() WITHIN GROUP (ORDER BY network) AS network,
                   mode() WITHIN GROUP (ORDER BY as_org) AS as_org,
                   mode() WITHIN GROUP (ORDER BY location_basis) AS location_basis,
                   MAX(ip) AS sample_peer_ip
            FROM base
            GROUP BY dest_host, location_state, city, lat, lon, country_code, edge_pop
        ),
        hosts AS (
            SELECT dest_host, COUNT(*) AS total, COUNT(*) FILTER (WHERE has_pii) AS pii_events,
                   MAX(timestamp) AS last_contact, mode() WITHIN GROUP (ORDER BY operator) AS operator
            FROM base GROUP BY dest_host
        )
        SELECT h.dest_host, h.operator, h.total, h.pii_events, h.last_contact,
               t.location_state, t.location_basis, t.city, t.lat, t.lon, t.country_code, t.country_name,
               t.edge_pop, t.network, t.as_org, t.sample_peer_ip
        FROM hosts h JOIN tuples t ON t.dest_host = h.dest_host AND t.rk = 1
        ORDER BY h.total DESC, h.dest_host
        LIMIT ${MAP_DESTINATIONS}
    `;
}

/**
 * @param {object} filters
 * @param {'day'|'hour'} interval
 * @param {{ buildFilters: Function, normalizeCategory?: Function }} deps
 *   buildFilters from the store; normalizeCategory from core/privacy/piiCategories,
 *   passed in by the route so this platform module does not reach into core.
 */
async function buildOverview(filters, interval, { buildFilters, normalizeCategory }) {
    const { where, params } = buildFilters(filters);
    const and = where ? `${where} AND` : 'WHERE';
    const period = interval === 'hour'
        ? "to_char(date_trunc('hour', timestamp), 'YYYY-MM-DD HH24:00')"
        : "to_char(date_trunc('day', timestamp), 'YYYY-MM-DD')";

    const [summary, timeline, destinations, topNonEu, topIntegrations, actors, topUsers, piiRows, dataRows, health] = await Promise.all([
        getOne(`
            SELECT
                COUNT(*) AS total_calls,
                COUNT(DISTINCT integration_type) AS unique_integrations,
                COUNT(DISTINCT ${DEST_EXPR}) AS unique_destinations,
                COUNT(DISTINCT user_id) AS unique_users,
                ${stateCounts()},
                COUNT(*) FILTER (WHERE ${NON_EU}) AS non_eu_count,
                COUNT(*) FILTER (WHERE ${NON_EU} AND ${HAS_PII}) AS pii_non_eu_count,
                COUNT(*) FILTER (WHERE ${LOCATED}) AS located_count,
                COUNT(*) FILTER (WHERE ${HAS_PII}) AS pii_events,
                COUNT(*) FILTER (WHERE status = 'error') AS error_count,
                COUNT(*) FILTER (WHERE status = 'blocked') AS blocked_count,
                -- The Shield's outcome per call, as the row-level reading does
                -- it: a blocked call is the shield's stop (counted from its own
                -- event), a call with a find left with it, and of the rest only
                -- a SCANNED call is "no personal data"; an unscanned one is
                -- "not checked". Same scan fallback as health.scan_levels.
                COUNT(*) FILTER (WHERE status IS DISTINCT FROM 'blocked' AND NOT (${HAS_PII})
                    AND NOT (pii_scan_level = 'none' AND pii_scan_enabled IS NOT TRUE)) AS clean_count,
                COUNT(*) FILTER (WHERE status IS DISTINCT FROM 'blocked' AND NOT (${HAS_PII})
                    AND pii_scan_level = 'none' AND pii_scan_enabled IS NOT TRUE) AS unchecked_count,
                ROUND(AVG(duration_ms)) AS avg_duration_ms
            FROM integration_activity_log ${where}
        `, params),
        getAll(`
            SELECT
                ${period} AS period,
                COUNT(*) AS total,
                ${stateCounts()},
                COUNT(*) FILTER (WHERE ${NON_EU}) AS non_eu_count,
                COUNT(*) FILTER (WHERE ${HAS_PII}) AS pii_events,
                COUNT(*) FILTER (WHERE status = 'error') AS errors
            FROM integration_activity_log ${where}
            GROUP BY period ORDER BY period ASC
        `, params),
        getAll(_destinationsSql(and), params),
        getAll(`
            SELECT
                ${DEST_EXPR} AS dest_host,
                mode() WITHIN GROUP (ORDER BY operator) AS operator,
                mode() WITHIN GROUP (ORDER BY country_name) AS country_name,
                COUNT(*) AS total,
                COUNT(*) FILTER (WHERE ${HAS_PII}) AS pii_events
            FROM integration_activity_log ${and} ${NON_EU} AND ${DEST_EXPR} IS NOT NULL
            GROUP BY 1 ORDER BY total DESC LIMIT 10
        `, params),
        getAll(`
            SELECT
                integration_type,
                COUNT(*) AS total,
                COUNT(*) FILTER (WHERE ${HAS_PII}) AS pii_events,
                COUNT(*) FILTER (WHERE ${NON_EU}) AS non_eu_count,
                COUNT(*) FILTER (WHERE status = 'error') AS errors,
                MAX(timestamp) AS last_used
            FROM integration_activity_log ${and} integration_type IS NOT NULL
            GROUP BY integration_type ORDER BY total DESC LIMIT 10
        `, params),
        getAll(`
            SELECT
                CASE WHEN automation_id IS NOT NULL THEN 'automation'
                     WHEN agent_id IS NOT NULL THEN 'agent'
                     ELSE 'direct_chat' END AS actor_kind,
                COALESCE(automation_id, agent_id, 'direct_chat') AS key,
                COALESCE(NULLIF(agent_name, ''), automation_id, agent_id, 'Direct chat') AS label,
                COUNT(*) AS total,
                COUNT(*) FILTER (WHERE ${NON_EU}) AS non_eu_count,
                COUNT(*) FILTER (WHERE ${NON_EU} AND ${HAS_PII}) AS pii_non_eu_count
            FROM integration_activity_log ${where}
            GROUP BY 1, 2, 3 ORDER BY total DESC LIMIT 10
        `, params),
        getAll(`
            SELECT
                user_id,
                COUNT(*) AS total,
                COUNT(*) FILTER (WHERE ${NON_EU}) AS non_eu_count,
                COUNT(*) FILTER (WHERE ${HAS_PII}) AS pii_events,
                MAX(timestamp) AS last_activity
            FROM integration_activity_log ${and} user_id IS NOT NULL
            GROUP BY user_id ORDER BY total DESC LIMIT 10
        `, params),
        getAll(`
            SELECT
                trim(cat) AS category,
                COUNT(*) AS count,
                COUNT(*) FILTER (WHERE ${NON_EU}) AS non_eu_count
            FROM integration_activity_log,
                 unnest(string_to_array(pii_categories_detected, ',')) AS cat
            ${and} ${HAS_PII} AND trim(cat) != ''
            GROUP BY trim(cat) ORDER BY count DESC
        `, params),
        getAll(`
            SELECT trim(cat) AS category, COUNT(*) AS count
            FROM integration_activity_log,
                 unnest(string_to_array(data_categories, ',')) AS cat
            ${and} data_categories IS NOT NULL AND data_categories != ''
                AND trim(cat) NOT IN ('', 'unknown', 'auto_detected', 'mcp_payload', 'workflow_payload')
            GROUP BY trim(cat) ORDER BY count DESC LIMIT 15
        `, params),
        getOne(`
            SELECT
                MAX(timestamp) AS last_event_at,
                -- Read-side fallback for unbackfilled history: level 'none'
                -- with pii_scan_enabled=true can only be a pre-rework row that
                -- WAS GLiNER-scanned (new writers keep the two in sync).
                COUNT(*) FILTER (WHERE pii_scan_level = 'full'
                    OR (pii_scan_level = 'none' AND pii_scan_enabled = true)) AS scan_full,
                COUNT(*) FILTER (WHERE pii_scan_level = 'basic') AS scan_basic,
                COUNT(*) FILTER (WHERE pii_scan_level = 'none' AND pii_scan_enabled = false) AS scan_none,
                ROUND(100.0 * COUNT(*) FILTER (WHERE operator IS NULL OR operator = 'Unknown')
                    / GREATEST(COUNT(*), 1), 1) AS unknown_operator_pct
            FROM integration_activity_log ${where}
        `, params),
    ]);

    const total = Number(summary?.total_calls) || 0;
    const outside = Number(summary?.non_eu_count) || 0;
    const piiOutside = Number(summary?.pii_non_eu_count) || 0;
    const located = Number(summary?.located_count) || 0;
    const score = sovereigntyScore(outside, piiOutside, located);
    const scoreDelta = score === null ? null : await _previousWindowDelta(filters, buildFilters, score);

    const mapDestinations = (destinations || []).map(_destination);
    // Status of the database, not of a lookup: after a quiet warm boot nothing
    // has loaded it yet, and "missing" would be a false alarm on the map.
    await geo.loadGeoDb();
    const status = geo.geoDbStatus();
    return {
        summary: {
            ...summary,
            located_count: located,
            via_network_count: Number(summary?.via_network_count) || 0,
            unknown_count: Number(summary?.unknown_count) || 0,
            coverage_pct: total > 0 ? Math.round((1000 * located) / total) / 10 : null,
            sovereignty_score: score,
            score_delta: scoreDelta,
        },
        timeline,
        top: {
            destinations: mapDestinations.slice(0, TOP_DESTINATIONS),
            non_eu_destinations: topNonEu,
            integrations: topIntegrations,
            actors,
            users: topUsers,
        },
        map: {
            origin: geo.serverOrigin(),
            destinations: mapDestinations,
            attribution: geo.geoAttribution(status.edition),
            geo_db: { available: !!status.available, edition: status.edition || null, date: status.date || null },
        },
        pii_categories: _rollupByCategory(piiRows, 'category', normalizeCategory),
        data_categories: (dataRows || []).map(r => ({ category: r.category, count: Number(r.count) || 0 })),
        health: {
            last_event_at: health?.last_event_at || null,
            scan_levels: {
                full: Number(health?.scan_full) || 0,
                basic: Number(health?.scan_basic) || 0,
                none: Number(health?.scan_none) || 0,
            },
            unknown_operator_pct: Number(health?.unknown_operator_pct) || 0,
            geo_db: !!status.available,
        },
    };
}

/** Score delta vs the PREVIOUS window of equal length (when the window is known). */
async function _previousWindowDelta(filters, buildFilters, score) {
    if (!filters.startDate || !filters.endDate) return null;
    try {
        const start = new Date(filters.startDate).getTime();
        const end = new Date(filters.endDate).getTime();
        if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
        const { where, params } = buildFilters({
            ...filters,
            startDate: new Date(start - (end - start)).toISOString(),
            endDate: new Date(start).toISOString(),
        });
        const prev = await getOne(`
            SELECT COUNT(*) FILTER (WHERE ${LOCATED}) AS located,
                   COUNT(*) FILTER (WHERE ${NON_EU}) AS non_eu,
                   COUNT(*) FILTER (WHERE ${NON_EU} AND ${HAS_PII}) AS pii_non_eu
            FROM integration_activity_log ${where}
        `, params);
        const prevScore = sovereigntyScore(Number(prev?.non_eu) || 0, Number(prev?.pii_non_eu) || 0, Number(prev?.located) || 0);
        return prevScore === null ? null : score - prevScore;
    } catch {
        return null; // the delta is decoration
    }
}

module.exports = { buildOverview, sovereigntyScore, _rollupByCategory };
