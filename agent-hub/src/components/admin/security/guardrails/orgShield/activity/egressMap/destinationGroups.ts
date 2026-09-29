/**
 * The destination list under the map, as data: which rows it shows, in which
 * region group, and how long each row's bar is. Pure, and tested
 * (destinationGroups.test.ts).
 *
 * ── Never pretend a destination was placed ────────────────────────────────
 * The list is the busiest destinations the pane hands it, plus EVERY one the
 * map could not place, each with the reason the server gave. A destination
 * missing from the map is therefore always somewhere on the screen, and
 * never silently left out because it was not among the busiest.
 */

import { REGION_ORDER, type Region } from '../../shieldPalette';
import { unplacedReason, type MapDestination, type UnplacedDestination, type UnplacedReason } from './mapModel';

export interface DestinationGroup {
    region: Region;
    rows: MapDestination[];
    /** Calls in this region, from the pane; null when it did not say. */
    calls: number | null;
    /** Share of all calls, rounded; null when unknown. */
    pct: number | null;
}

/** The list's rows: the busiest destinations first, then every unplaced one not already there. */
export function listRows(busiest: MapDestination[], unplaced: UnplacedDestination[]): MapDestination[] {
    const seen = new Set(busiest.map(d => d.host));
    return [...busiest, ...unplaced.filter(d => !seen.has(d.host))];
}

/**
 * Why a row has no pin, or null when it has one (or sits on your server). A
 * destination with no known location always has a reason; one in a known
 * region only when the map could not place it.
 */
export function missingReason(d: MapDestination, unplaced: Map<string, UnplacedReason> | null): UnplacedReason | null {
    if (d.state === 'unknown') return unplaced?.get(d.host) || unplacedReason(d);
    if (d.state === 'local') return null;
    return unplaced?.get(d.host) || null;
}

/** Rows by region, in REGION_ORDER, busiest first; a region without rows is left out. */
export function groupDestinations(rows: MapDestination[], regionTotals?: Partial<Record<Region, number>> | null): DestinationGroup[] {
    const all = regionTotals ? REGION_ORDER.reduce((s, r) => s + (Number(regionTotals[r]) || 0), 0) : 0;
    return REGION_ORDER.map((region) => {
        const inRegion = rows
            .filter(d => d.state === region)
            .sort((a, b) => (b.total - a.total) || a.host.localeCompare(b.host));
        const calls = regionTotals ? Number(regionTotals[region]) || 0 : null;
        const pct = calls !== null && all > 0 ? Math.round((100 * calls) / all) : null;
        return { region, rows: inRegion, calls, pct };
    }).filter(g => g.rows.length > 0);
}

export interface RowBar {
    /** The row's calls against the busiest row, as a share of the track (0..1). */
    calls: number;
    /** The part of that which carried personal data, as a share of the track. */
    pii: number;
}

/** A visible sliver for any row with calls: a 1-call row next to a 5,000-call one still shows. */
const MIN_SHARE = 0.015;

export function rowBar(d: Pick<MapDestination, 'total' | 'piiEvents'>, maxTotal: number): RowBar {
    if (!(d.total > 0) || !(maxTotal > 0)) return { calls: 0, pii: 0 };
    const calls = Math.max(MIN_SHARE, Math.min(1, d.total / maxTotal));
    const pii = d.piiEvents > 0 ? Math.max(MIN_SHARE, calls * Math.min(1, d.piiEvents / d.total)) : 0;
    return { calls, pii };
}
