/**
 * The egress map as data: where each destination sits, which line it gets,
 * how it is coloured, which pins merge into one bubble, and where the camera
 * starts. Pure: no React, no DOM, no `t()`. The components under this folder
 * only draw what this module decides, so every decision here has a test on
 * numbers rather than on rendered SVG (mapModel.test.ts).
 *
 * The geometry on top (curves, framing, zoom, clustering) is
 * mapGeometry.ts; this file is about the DATA: what a destination is, where
 * it sits, and what colour it gets.
 *
 * ── What it refuses to imply ──────────────────────────────────────────────
 * A destination with no known location is never placed at a guess: it goes
 * to `unplaced` with the reason the server gave. A destination on your own
 * server or network never gets a pin of its own, because a pin would say the
 * data went somewhere.
 */

import { geoNaturalEarth1, type GeoProjection } from 'd3-geo';

import { REGION_FILL, type Region } from '../../shieldPalette';
import { boxOf, type Box, type PinCluster, type Pt, type Size } from './mapGeometry';

/** Where a destination is, as the server says: the same five values as a Privacy Shield region. */
export type LocationState = Region;
export type LocationBasis =
    | 'socket' | 'edge_header' | 'recent_socket' | 'proxy' | 'child_process'
    | 'browser' | 'backfill' | 'none' | 'no_geo_db';


/** One destination as the overview and egress endpoints send it. Loose on
 *  purpose: a server that predates the location columns omits most of it. */
export interface RawDestination {
    dest_host?: string | null;
    tls_servername?: string | null;
    server_endpoint?: string | null;
    operator?: string | null;
    as_org?: string | null;
    network?: string | null;
    country_code?: string | null;
    country_name?: string | null;
    city?: string | null;
    lat?: number | string | null;
    lon?: number | string | null;
    location_state?: string | null;
    location_basis?: string | null;
    edge_pop?: string | null;
    is_eu?: boolean | null;
    is_local?: boolean | null;
    total?: number | string | null;
    pii_events?: number | string | null;
    last_contact?: string | null;
    sample_peer_ip?: string | null;
    peer_ip?: string | null;
}

export interface MapDestination {
    host: string;
    total: number;
    piiEvents: number;
    state: LocationState;
    basis: LocationBasis | null;
    countryCode: string;
    countryName: string;
    city: string;
    lat: number | null;
    lon: number | null;
    operator: string;
    asOrg: string;
    network: string;
    edgePop: string;
    lastContact: string | null;
    peerIp: string;
}

/** One country outline, projected in base space. */
export interface CountryShape { key: string; d: string; code: string | null }

export interface MapOrigin {
    lat: number;
    lon: number;
    label?: string | null;
    country_code?: string | null;
    country_name?: string | null;
}

/** The band of latitudes the map frames: Canada, Greenland and New Zealand in, Antarctica out. */
export const WORLD_LAT: [number, number] = [-58, 84];

const STATES = new Set<LocationState>(['local', 'eu', 'outside', 'via_network', 'unknown']);
const BASES = new Set<LocationBasis>([
    'socket', 'edge_header', 'recent_socket', 'proxy', 'child_process', 'browser', 'backfill', 'none', 'no_geo_db',
]);

/**
 * The EEA plus the two jurisdictions the GDPR treats as adequate. Mirrors
 * EU_EEA_COUNTRIES on the server: the tint of a country and the `eu` state of
 * a row must never disagree about the same place.
 */
export const EEA_CODES = new Set([
    'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE',
    'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE',
    'IS', 'LI', 'NO',
    'CH', 'GB',
]);

const num = (v: unknown): number => {
    const n = typeof v === 'number' ? v : Number(v);
    return Number.isFinite(n) ? n : 0;
};
const coord = (v: unknown, limit: number): number | null => {
    if (v === null || v === undefined || v === '') return null;
    const n = typeof v === 'number' ? v : Number(v);
    return Number.isFinite(n) && Math.abs(n) <= limit ? n : null;
};
const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/** A row written before the location columns existed still has is_local / is_eu / a country. */
function legacyState(raw: RawDestination): LocationState {
    if (raw.is_local) return 'local';
    if (raw.is_eu) return 'eu';
    if (str(raw.country_code)) return 'outside';
    return 'unknown';
}

export function hostOf(raw: RawDestination): string {
    return str(raw.dest_host) || str(raw.tls_servername) || str(raw.server_endpoint);
}

export function toMapDestination(raw: RawDestination): MapDestination {
    const stateRaw = str(raw.location_state) as LocationState;
    const basisRaw = str(raw.location_basis) as LocationBasis;
    let lat = coord(raw.lat, 90);
    let lon = coord(raw.lon, 180);
    // 0,0 is where a missing value lands when something upstream casts null
    // to a number. Nobody's server is in the Gulf of Guinea.
    if (lat === 0 && lon === 0) { lat = null; lon = null; }
    return {
        host: hostOf(raw),
        total: num(raw.total),
        piiEvents: num(raw.pii_events),
        state: STATES.has(stateRaw) ? stateRaw : legacyState(raw),
        basis: BASES.has(basisRaw) ? basisRaw : null,
        countryCode: str(raw.country_code).toUpperCase(),
        countryName: str(raw.country_name),
        city: str(raw.city),
        lat: lat === null || lon === null ? null : lat,
        lon: lat === null || lon === null ? null : lon,
        operator: str(raw.operator),
        asOrg: str(raw.as_org),
        network: str(raw.network),
        edgePop: str(raw.edge_pop).toUpperCase(),
        lastContact: str(raw.last_contact) || null,
        peerIp: str(raw.sample_peer_ip) || str(raw.peer_ip),
    };
}

/** Normalise and drop rows without a host; the first row for a host wins. */
export function toMapDestinations(raws: RawDestination[] | null | undefined): MapDestination[] {
    const seen = new Set<string>();
    const out: MapDestination[] = [];
    for (const raw of raws || []) {
        const d = toMapDestination(raw || {});
        if (!d.host || seen.has(d.host)) continue;
        seen.add(d.host);
        out.push(d);
    }
    return out;
}

/* ── Projection ──────────────────────────────────────────────────────── */

/** Points that span the framed band: NE1 is widest at the equator. */
const WORLD_FRAME = {
    type: 'MultiPoint' as const,
    coordinates: [[-179.9999, 0], [179.9999, 0], [0, WORLD_LAT[1]], [0, WORLD_LAT[0]]],
};

/** Natural Earth, fitted so the whole framed band fills the card at zoom 1. */
export function worldProjection(size: Size, inset = 4): GeoProjection {
    return geoNaturalEarth1().fitExtent([[inset, inset], [size.w - inset, size.h - inset]], WORLD_FRAME);
}

export function worldBox(projection: GeoProjection): Box {
    const pts = WORLD_FRAME.coordinates.map(c => projection(c as Pt)).filter(Boolean) as Pt[];
    return boxOf(pts) as Box;
}

/* ── Placement ───────────────────────────────────────────────────────── */

export type UnplacedReason = 'none' | 'child_process' | 'proxy' | 'no_geo_db' | 'backfill' | 'no_coordinates';

/** A bubble of destinations, as the map draws it. */
export type DestinationCluster = PinCluster<PlacedDestination>;

export interface PlacedDestination extends MapDestination {
    /** Base-space position. */
    xy: Pt;
    /** true when the server gave coordinates; false when this is the country pin. */
    exact: boolean;
}
export interface UnplacedDestination extends MapDestination { reason: UnplacedReason }
export interface Placement {
    placed: PlacedDestination[];
    local: MapDestination[];
    unplaced: UnplacedDestination[];
}

const UNKNOWN_REASONS = new Set<UnplacedReason>(['none', 'child_process', 'proxy', 'no_geo_db', 'backfill']);

export function unplacedReason(d: MapDestination): UnplacedReason {
    if (d.basis && UNKNOWN_REASONS.has(d.basis as UnplacedReason)) return d.basis as UnplacedReason;
    return d.state === 'unknown' ? 'none' : 'no_coordinates';
}

/** Server coordinates first, the country pin second. null when neither is known. */
export function lonLatOf(d: MapDestination, pins: Record<string, number[]>): { lonLat: Pt; exact: boolean } | null {
    if (d.lat !== null && d.lon !== null) return { lonLat: [d.lon, d.lat], exact: true };
    const pin = d.countryCode ? pins[d.countryCode] : undefined;
    if (pin && pin.length === 2) return { lonLat: [pin[0], pin[1]], exact: false };
    return null;
}

export function placeDestinations(
    dests: MapDestination[],
    pins: Record<string, number[]>,
    project: (lonLat: Pt) => Pt | null,
): Placement {
    const out: Placement = { placed: [], local: [], unplaced: [] };
    for (const d of dests) {
        if (d.state === 'local') { out.local.push(d); continue; }
        if (d.state === 'unknown') { out.unplaced.push({ ...d, reason: unplacedReason(d) }); continue; }
        const where = lonLatOf(d, pins);
        const xy = where ? project(where.lonLat) : null;
        if (!where || !xy || !Number.isFinite(xy[0]) || !Number.isFinite(xy[1])) {
            out.unplaced.push({ ...d, reason: unplacedReason(d) });
            continue;
        }
        out.placed.push({ ...d, xy, exact: where.exact });
    }
    return out;
}

/* ── Style ───────────────────────────────────────────────────────────── */

/** Your server, drawn in the "your own server" region colour. */
export const ORIGIN_FILL = REGION_FILL.local;
/** A pin whose destination got none of the kind being filtered on. */
export const MUTED_FILL = 'var(--text-tertiary)';

export type LineDash = 'solid' | 'dashed' | 'dotted';
export interface LineStyle { colour: string; dash: LineDash; animated: boolean }

/**
 * Every line in its region's colour. Outside Europe is dashed and moves
 * (the component stops it under reduced motion): that is the line to look
 * at. A line through a global network is dotted, never dashed: its pin is the
 * network's edge, not the service, so it must read neither as a solid fact
 * nor as "outside Europe".
 */
export function lineStyle(d: Pick<MapDestination, 'state'>): LineStyle {
    const colour = REGION_FILL[d.state];
    if (d.state === 'outside') return { colour, dash: 'dashed', animated: true };
    if (d.state === 'via_network') return { colour, dash: 'dotted', animated: false };
    return { colour, dash: 'solid', animated: false };
}

/** Line width by call count on a log scale: 1.25px for one call, 4.5px for the busiest. */
export function lineWidth(total: number, maxTotal: number): number {
    if (!(maxTotal > 0) || !(total > 0)) return 1.25;
    const share = Math.log1p(total) / Math.log1p(maxTotal);
    return Math.round((1.25 + 3.25 * Math.min(1, share)) * 100) / 100;
}

/** Above this many calls for the busiest destination, pins scale down together. */
export const PIN_REF_CALLS = 100;

/**
 * A pin's radius: 4 + 1.3·√n, and 3.5 for a destination with no calls. A
 * busy organisation's counts are scaled so its busiest pin is as big as one
 * with PIN_REF_CALLS calls (17px): unscaled, 5,000 calls would be a 96px disc.
 */
export function pinRadius(n: number, maxTotal: number): number {
    if (!(n > 0)) return 3.5;
    const scale = maxTotal > PIN_REF_CALLS ? PIN_REF_CALLS / maxTotal : 1;
    return Math.round((4 + 1.3 * Math.sqrt(n * scale)) * 10) / 10;
}

/** Which countries received data, and whether that was inside Europe. The edge of a global network is not a destination. */
export function receivedByCountry(placed: PlacedDestination[]): Map<string, 'eu' | 'outside'> {
    const out = new Map<string, 'eu' | 'outside'>();
    for (const d of placed) {
        if (!d.countryCode || (d.state !== 'eu' && d.state !== 'outside')) continue;
        if (out.get(d.countryCode) !== 'outside') out.set(d.countryCode, d.state);
    }
    return out;
}

/** Europe tinted in its region colour; a country that received data a shade deeper. */
export function countryFill(code: string | null | undefined, received: 'eu' | 'outside' | undefined): string {
    if (received === 'outside') return 'color-mix(in srgb, var(--kind-skill) 9%, var(--bg-tertiary))';
    if (received === 'eu') return 'color-mix(in srgb, var(--type-trigger) 34%, var(--bg-secondary))';
    if (code && EEA_CODES.has(code)) return 'color-mix(in srgb, var(--type-trigger) 18%, var(--bg-secondary))';
    return 'var(--bg-tertiary)';
}
