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

import { toMapDestination, type LocationBasis, type LocationState } from './egressMap/mapModel';
import { bucketIndexFor, type FilterableRow } from './shieldFilters';

/** One raw guardrail event, as /api/usage/guardrails/recent sends it. */
export interface GuardEventRow {
    id: string | number;
    timestamp: string;
    user_id?: string | null;
    display_name?: string | null;
    avatar?: string | null;
    source?: string | null;
    violation_categories?: string | string[] | null;
    action_taken?: string | null;
    [key: string]: unknown;
}

/** One raw egress event, as /api/usage/integrations/egress sends it. */
export interface EgressEventRow {
    id: string | number;
    timestamp: string;
    user_id?: string | null;
    display_name?: string | null;
    avatar?: string | null;
    source?: string | null;
    pii_categories_detected?: string | string[] | null;
    dest_host?: string | null;
    tls_servername?: string | null;
    server_endpoint?: string | null;
    country_name?: string | null;
    country_code?: string | null;
    operator?: string | null;
    [key: string]: unknown;
}

/** The time window rows are bucketed into. */
export interface BucketWindow {
    start: string | number | Date;
    end: string | number | Date;
    buckets: number;
}

/** One normalised row, guard or egress, in the shape the filters read. */
export type ShieldRow = FilterableRow & {
    id: string;
    source: 'guard' | 'egress';
    ts: string;
    person: string;
    personLabel: string;
    avatar: string | null;
    place: string;
    kinds: string[];
    dest: string | null;
    bucket: number | null;
    raw: GuardEventRow | EgressEventRow;
    action?: string;
    state?: LocationState;
    basis?: LocationBasis | null;
    isLocal?: boolean;
    isEu?: boolean;
    country?: string;
    countryCode?: string;
    countryName?: string;
    city?: string;
    lat?: number | null;
    lon?: number | null;
    edgePop?: string;
    network?: string;
    asOrg?: string;
    peerIp?: string;
    operator?: string;
};

/** The fields `destinationsFromRows` reads: a call's destination and where it went. */
export interface DestinationRow {
    dest: string | null;
    ts?: string | null;
    kinds?: string[] | null;
    state?: string | null;
    basis?: string | null;
    city?: string | null;
    lat?: number | null;
    lon?: number | null;
    countryCode?: string | null;
    countryName?: string | null;
    country?: string | null;
    edgePop?: string | null;
    network?: string | null;
    operator?: string | null;
    asOrg?: string | null;
    peerIp?: string | null;
}

/** One destination in the overview's shape, as a filtered view derives it. */
export type DestinationSummary = {
    dest_host: string;
    total: number;
    pii_events: number;
    last_contact: string | null;
    location_state?: string | null;
    location_basis?: string | null;
    city?: string | null;
    lat?: number | null;
    lon?: number | null;
    country_code?: string | null;
    country_name?: string | null;
    edge_pop?: string | null;
    network?: string | null;
    operator?: string | null;
    as_org?: string | null;
    sample_peer_ip?: string | null;
    is_local: boolean;
    is_eu: boolean;
};

/**
 * Audit markers (`scan_timeout`, `privacy_protection_unavailable`, …) travel in
 * the categories column but are not categories. They are deliberately left IN
 * `kinds` rather than filtered out: "show me everything sent while the scanner
 * was down" is a real question and those markers are the only answer to it.
 * `activityLabels.ts` owns turning them into words.
 */

/** A comma-joined category column → deduped ids. */
function splitCategories(value: string | string[] | null | undefined): string[] {
    if (Array.isArray(value)) return [...new Set(value.map(v => String(v).trim()).filter(Boolean))];
    if (!value) return [];
    // Legacy rows repeat the same label once per occurrence
    // ("Person Name, Person Name, …"), which reads as noise and would triple
    // that category's weight in the top-5 lists.
    return [...new Set(String(value).split(',').map(s => s.trim()).filter(Boolean))];
}

/** The host a row's data went to, most precise field first. */
function destinationOf(row: EgressEventRow): string {
    return row.dest_host || row.tls_servername || row.server_endpoint || '';
}

/**
 * @param {object[]} rows      raw guardrail events
 * @param {object}   [opts]
 * @param {Function} [opts.placeLabel]  row → "Direct chat" / "Automation · polismail"
 * @param {object}   [opts.window]      { start, end, buckets } to bucket rows by; omitted, `bucket` is null
 */
export function normaliseGuardRows(
    rows: Record<string, unknown>[] | null | undefined,
    { placeLabel, window: win }: { placeLabel?: (row: GuardEventRow) => string; window?: BucketWindow } = {},
): ShieldRow[] {
    return (rows || []).map(raw => normaliseGuardRow(raw as GuardEventRow, placeLabel, win));
}

function normaliseGuardRow(
    row: GuardEventRow,
    placeLabel: ((row: GuardEventRow) => string) | undefined,
    win: BucketWindow | undefined,
): ShieldRow {
    return ({
        id: String(row.id),
        source: 'guard' as const,
        ts: row.timestamp,
        person: row.user_id || '',
        personLabel: row.display_name || row.user_id || '',
        avatar: row.avatar || null,
        place: placeLabel ? placeLabel(row) : (row.source || ''),
        kinds: splitCategories(row.violation_categories),
        action: row.action_taken || '',
        dest: null,
        bucket: win ? bucketIndexFor(row.timestamp, win) : null,
        raw: row,
    });
}

export function normaliseEgressRows(
    rows: Record<string, unknown>[] | null | undefined,
    { placeLabel, window: win }: { placeLabel?: (row: EgressEventRow) => string; window?: BucketWindow } = {},
): ShieldRow[] {
    return (rows || []).map(raw => normaliseEgressRow(raw as EgressEventRow, placeLabel, win));
}

function normaliseEgressRow(
    row: EgressEventRow,
    placeLabel: ((row: EgressEventRow) => string) | undefined,
    win: BucketWindow | undefined,
): ShieldRow {
        // One reading of the location columns for the log, the map and the
        // figures: `location_state` when the server sends it, otherwise derived
        // from is_local / is_eu / country the way the server backfills it.
        const loc = toMapDestination(row);
        return {
            id: String(row.id),
            source: 'egress' as const,
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
            bucket: win ? bucketIndexFor(row.timestamp, win) : null,
            raw: row,
        };
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
interface HostEntry {
    host: string;
    total: number;
    pii: number;
    last: string | null;
    tuples: Map<string, { n: number; row: DestinationRow }>;
}

export function destinationsFromRows(rows: DestinationRow[] | null | undefined, limit = 12): DestinationSummary[] {
    const byHost = new Map<string, HostEntry>();
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
