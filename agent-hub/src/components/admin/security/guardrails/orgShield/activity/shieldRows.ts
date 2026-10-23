/**
 * Server rows → the one shape the cross-filter and the table both read.
 *
 * The two detail endpoints return different objects for what is, to an admin,
 * the same question ("what happened, to whose data, and where did it go"):
 *
 *   /api/usage/guardrails/recent    violation_categories, action_taken, source…
 *   /api/usage/integrations/egress  pii_categories_detected, dest_host, is_eu…
 *
 * Filtering, ranking and bucketing should not each know both shapes, so they
 * are flattened once, here. Label lookup is INJECTED (`catLabel`,
 * `placeLabel`) rather than imported: this module stays free of `t()` so it
 * can be tested on data.
 *
 * ── The filter axes are stored as IDS, displayed as labels ────────────────
 * `kinds` holds canonical category ids (`Email`, `Person`), not their
 * translations. A filter set by clicking a chip in Dutch has to keep matching
 * after the user switches to English, and two categories must never collide
 * because their labels happen to match.
 */

import { toMapDestination, type RawDestination } from './egressMap/mapModel';
import { bucketIndexFor } from './shieldFilters';
import type { StreamRow } from './shieldStream';

type BucketWindow = Parameters<typeof bucketIndexFor>[1];

/** A raw guardrail event as the activity log reads it. */
type GuardRow = {
    id?: string | number; timestamp?: string | number | Date; user_id?: string | null; display_name?: string | null;
    avatar?: string | null; source?: string | null; violation_categories?: string | string[] | null; action_taken?: string | null;
    [key: string]: unknown;
};

/** A raw egress destination row: the map's fields plus the event fields the log adds. */
type EgressRow = RawDestination & {
    id?: string | number; timestamp?: string; user_id?: string | null; display_name?: string | null;
    avatar?: string | null; source?: string | null; pii_categories_detected?: string | string[] | null;
    [key: string]: unknown;
};

/**
 * Audit markers (`scan_timeout`, `privacy_protection_unavailable`, …) travel in
 * the categories column but are not categories. They are deliberately left IN
 * `kinds` rather than filtered out: "show me everything sent while the scanner
 * was down" is a real question and those markers are the only answer to it.
 * `activityLabels.js` owns turning them into words.
 */

/** A comma-joined category column → deduped ids. */
function splitCategories(value: string | string[] | null | undefined) {
    if (Array.isArray(value)) return [...new Set(value.map(v => String(v).trim()).filter(Boolean))];
    if (!value) return [];
    // Legacy rows repeat the same label once per occurrence
    // ("Person Name, Person Name, …"), which reads as noise and would triple
    // that category's weight in the top-5 lists.
    return [...new Set(String(value).split(',').map(s => s.trim()).filter(Boolean))];
}

/** The host a row's data went to, most precise field first. */
function destinationOf(row: RawDestination) {
    return row.dest_host || row.tls_servername || row.server_endpoint || '';
}

/**
 * @param {object[]} rows      raw guardrail events
 * @param {object}   [opts]
 * @param {Function} [opts.placeLabel]  row → "Direct chat" / "Automation · polismail"
 * @param {object}   [opts.window]      { start, end, buckets } to bucket rows by; omitted, `bucket` is null
 */
export function normaliseGuardRows(rows: GuardRow[], { placeLabel, window: win }: { placeLabel?: (row: GuardRow) => string; window?: BucketWindow } = {}) {
    return (rows || []).map(row => ({
        id: String(row.id),
        source: 'guard',
        ts: row.timestamp,
        person: row.user_id || '',
        personLabel: row.display_name || row.user_id || '',
        avatar: row.avatar || null,
        place: placeLabel ? placeLabel(row) : (row.source || ''),
        kinds: splitCategories(row.violation_categories),
        action: row.action_taken || '',
        dest: null,
        bucket: win ? bucketIndexFor(row.timestamp ?? '', win) : null,
        raw: row,
    }));
}

export function normaliseEgressRows(rows: EgressRow[], { placeLabel, window: win }: { placeLabel?: (row: EgressRow) => string; window?: BucketWindow } = {}) {
    return (rows || []).map(row => {
        // One reading of the location columns for the log, the map and the
        // figures: `location_state` when the server sends it, otherwise derived
        // from is_local / is_eu / country the way the server backfills it.
        const loc = toMapDestination(row);
        return {
            id: String(row.id),
            source: 'egress',
            ts: row.timestamp,
            person: row.user_id || '',
            personLabel: row.display_name || row.user_id || '',
            avatar: row.avatar || null,
            place: placeLabel ? placeLabel(row) : (row.source || ''),
            kinds: splitCategories(row.pii_categories_detected),
            dest: destinationOf(row),
            state: loc.state,
            basis: loc.basis,
            isLocal: loc.state === 'local',
            isEu: loc.state === 'eu',
            country: row.country_name || row.country_code || '',
            countryCode: loc.countryCode,
            countryName: loc.countryName,
            city: loc.city,
            lat: loc.lat,
            lon: loc.lon,
            edgePop: loc.edgePop,
            network: loc.network,
            asOrg: loc.asOrg,
            peerIp: loc.peerIp,
            operator: row.operator || '',
            bucket: win ? bucketIndexFor(row.timestamp ?? '', win) : null,
            raw: row,
        };
    });
}

/**
 * The destinations a filtered view is left with, in the overview's own shape
 * (`top.destinations` / `map.destinations`), so the map and the list read one
 * shape whether they are showing the aggregate or a filtered sample.
 *
 * One location per host: the most frequent (state, city, coordinates,
 * country, edge) combination among its rows, the same rule the server uses.
 * Taking the most common value per COLUMN instead mixes the coordinates of
 * one place with the city of another.
 */
export function destinationsFromRows(rows: StreamRow[], limit: number = 12) {
    const byHost = new Map();
    for (const row of rows || []) {
        if (!row.dest) continue;
        let entry = byHost.get(row.dest);
        if (!entry) { entry = { host: row.dest, total: 0, pii: 0, last: null, tuples: new Map() }; byHost.set(row.dest, entry); }
        entry.total += 1;
        if ((row.kinds || []).length > 0) entry.pii += 1;
        if (row.ts && (!entry.last || String(row.ts) > String(entry.last))) entry.last = row.ts;
        const key = [row.state, row.city, row.lat, row.lon, row.countryCode, row.edgePop].join('|');
        const tuple = entry.tuples.get(key);
        if (tuple) tuple.n += 1; else entry.tuples.set(key, { n: 1, row });
    }
    return [...byHost.values()]
        .sort((a, b) => (b.total - a.total) || a.host.localeCompare(b.host))
        .slice(0, limit)
        .map(entry => {
            const { row } = [...entry.tuples.values()].sort((a, b) => b.n - a.n)[0];
            return {
                dest_host: entry.host,
                total: entry.total,
                pii_events: entry.pii,
                last_contact: entry.last,
                location_state: row.state,
                location_basis: row.basis,
                city: row.city,
                lat: row.lat,
                lon: row.lon,
                country_code: row.countryCode,
                country_name: row.countryName || row.country,
                edge_pop: row.edgePop,
                network: row.network,
                operator: row.operator,
                as_org: row.asOrg,
                sample_peer_ip: row.peerIp,
                is_local: row.state === 'local',
                is_eu: row.state === 'eu',
            };
        });
}
