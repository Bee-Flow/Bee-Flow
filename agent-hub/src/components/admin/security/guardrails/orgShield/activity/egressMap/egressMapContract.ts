/**
 * What the "What happened" pane hands the map card beyond the destinations
 * themselves: the cross-filter state the map shows and changes, and the
 * per-destination detail only the fetched rows know.
 *
 * Kept in its own module so the pane (which computes it) and the card (which
 * draws it) agree on one shape. Every field is plain data or a callback; the
 * card never reaches back into the pane's state.
 *
 * ── Sample, not window ────────────────────────────────────────────────────
 * `hostKinds` and `hostTypes` come from the fetched call rows (≤200), because
 * the server's destination aggregate carries no per-kind or per-type split.
 * A host that is busy but not in the sample simply has no entry, and the
 * card must then say less (e.g. "{n} with personal data") rather than guess.
 */

import type { Region } from '../../shieldPalette';

export interface KindCount {
    /** Canonical category id, as stored (`Email`, `Person`, …). */
    id: string;
    label: string;
    n: number;
}

export type DestinationType = 'tool' | 'web_search';

export interface EgressMapFilters {
    /** The kind filter that is on (a canonical category id), or null. */
    selectedKind: string | null;
    /** Toggle a kind; `null` clears the kind filter ("All data"). */
    onSelectKind: (id: string | null) => void;
    /** The region filter that is on, or null. */
    selectedRegion: Region | null;
    /** Toggle a region filter (a group header in the list). */
    onSelectRegion: (region: Region) => void;
    /** Kinds found in the calls that pass every OTHER filter, most first — the map's pills. */
    kindCounts: KindCount[];
    /** Per destination host: kinds found in the sampled calls to it, most first, as [id, n]. */
    hostKinds: Record<string, Array<[string, number]>>;
    /** Per destination host, from the sampled calls: what kind of call it was. Absent = unknown. */
    hostTypes: Record<string, DestinationType>;
    /** Calls per region, for the list's group headers (aggregate unfiltered, sample filtered). */
    regionTotals: Record<Region, number>;
    /** Category id → its label in the user's language. */
    catLabel: (id: string) => string;
}
