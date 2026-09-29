/**
 * The words for a destination's location, shared by the map tooltip, the
 * destination list, the "No known location" list and the egress table.
 *
 * `t` is injected rather than imported, like activityLabels.js does, so the
 * wording can be tested on data. Every string goes through a key: this is the
 * one screen whose subject is where data went, and "how we know" is the line
 * an auditor reads first.
 */

import type { TranslateFn } from '../../../../../../../hooks/useTranslation';
import type { MapDestination, UnplacedReason } from './mapModel';

type Loc = Pick<MapDestination, 'state' | 'basis' | 'city' | 'countryCode' | 'countryName' | 'network' | 'edgePop' | 'peerIp'>;

/** The network's name; when the server could not name it, a description that fits the sentence position. */
const networkName = (d: Loc, t: TranslateFn, atStart: boolean) => d.network || (atStart
    ? t('egress_map.global_network_start', 'A global network')
    : t('egress_map.global_network', 'a global network'));

/** "Toronto, Canada" · "Cloudflare edge, Amsterdam" · "Your server" · "" when nothing is known. */
export function placeLabel(d: Loc, t: TranslateFn): string {
    if (d.state === 'local') return t('egress_map.place_local', 'Your server');
    if (d.state === 'via_network') {
        const network = networkName(d, t, true);
        if (d.city) return t('egress_map.place_edge', '{network} edge, {city}', { network, city: d.city });
        if (d.edgePop) return t('egress_map.place_edge_pop', '{network} edge ({pop})', { network, pop: d.edgePop });
        return t('egress_map.place_edge_only', '{network} edge', { network });
    }
    const country = d.countryName || d.countryCode;
    if (d.city && country) return t('egress_map.place_city', '{city}, {country}', { city: d.city, country });
    return d.city || country || '';
}

/** The table's short form: "Toronto, CA" · "via Cloudflare, AMS" · "Your server" · "Unknown". */
export function shortLocation(d: Loc, t: TranslateFn): string {
    if (d.state === 'local') return t('egress_map.place_local', 'Your server');
    if (d.state === 'via_network') {
        const network = networkName(d, t, false);
        return d.edgePop
            ? t('egress_map.short_via', 'via {network}, {pop}', { network, pop: d.edgePop })
            : t('egress_map.short_via_only', 'via {network}', { network });
    }
    if (d.state === 'unknown') return t('egress_map.short_unknown', 'Unknown');
    if (d.city && d.countryCode) return `${d.city}, ${d.countryCode}`;
    return d.countryName || d.countryCode || t('egress_map.short_unknown', 'Unknown');
}

export function reasonLabel(reason: UnplacedReason, t: TranslateFn): string {
    switch (reason) {
        case 'child_process': return t('egress_map.reason_child_process', 'The tool runs as a separate program, so its connections are not visible');
        case 'proxy': return t('egress_map.reason_proxy', 'Sent through a proxy, so the server behind it is not visible');
        case 'no_geo_db': return t('egress_map.reason_no_geo_db', 'The location database is missing on this server');
        case 'backfill': return t('egress_map.reason_backfill', 'Old record, from before exact capture');
        case 'no_coordinates': return t('egress_map.reason_no_coordinates', 'Its place was not recorded');
        default: return t('egress_map.reason_none', 'No connection was seen');
    }
}

/** The bases that name the connection the location was read from. */
function seenOn(d: Loc, t: TranslateFn): string | null {
    const ip = d.peerIp || '?';
    if (d.basis === 'socket') {
        return d.peerIp
            ? t('egress_map.how_socket', 'Seen on the connection to {ip}', { ip })
            : t('egress_map.how_socket_noip', 'Seen on the connection itself');
    }
    if (d.basis === 'recent_socket') return t('egress_map.how_recent_socket', 'Seen on a recent connection to {ip}', { ip });
    if (d.basis === 'browser') return t('egress_map.how_browser', 'Seen by the web browser tool on the connection to {ip}', { ip });
    return null;
}

const NOT_SEEN = new Set(['none', 'child_process', 'proxy', 'no_geo_db']);

/** The "How we know" line. */
export function howWeKnow(d: Loc, t: TranslateFn): string {
    if (d.state === 'local') return t('egress_map.how_local', 'Your own server or network');
    const seen = seenOn(d, t);
    if (seen) return seen;
    if (d.basis === 'edge_header') {
        return t('egress_map.how_edge', '{network} reported its edge ({pop}); the service behind it is not visible', {
            network: networkName(d, t, true), pop: d.edgePop || '?',
        });
    }
    if (d.basis === 'backfill') return t('egress_map.how_backfill', 'Recorded before exact capture; location approximate');
    if (d.basis && NOT_SEEN.has(d.basis)) return reasonLabel(d.basis as UnplacedReason, t);
    return d.state === 'unknown' ? reasonLabel('none', t) : t('egress_map.how_unrecorded', 'Not recorded for this destination');
}

const UNITS: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ['day', 86_400_000], ['hour', 3_600_000], ['minute', 60_000],
];

/** "3 hours ago", in the reader's language. Empty for a missing or broken timestamp. */
export function relativeAgo(iso: string | null | undefined, locale?: string, now = Date.now()): string {
    if (!iso) return '';
    const then = new Date(iso).getTime();
    if (!Number.isFinite(then)) return '';
    const diff = then - now;
    let fmt: Intl.RelativeTimeFormat;
    try { fmt = new Intl.RelativeTimeFormat(locale || undefined, { numeric: 'auto' }); } catch { fmt = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' }); }
    if (Math.abs(diff) >= 30 * 86_400_000) return new Date(then).toLocaleDateString(locale || undefined);
    for (const [unit, ms] of UNITS) {
        if (Math.abs(diff) >= ms) return fmt.format(Math.round(diff / ms), unit);
    }
    return fmt.format(0, 'minute');
}

/** Tone of a count or a location, by state: green stayed, orange left Europe, grey otherwise. */
export function stateInk(state: MapDestination['state']): string {
    if (state === 'local' || state === 'eu') return 'text-[var(--success-ink)]';
    if (state === 'outside') return 'text-[var(--warning-ink)]';
    return 'text-[var(--text-secondary)]';
}
