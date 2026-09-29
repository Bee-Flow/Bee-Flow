/**
 * "Where it went": the map, the destinations under it grouped by region, and
 * a footnote on what a location means.
 *
 * The map and the list share one hover: pointing at a row lights up its pin
 * and line, pointing at a pin lights up its row. A click on a pin, a line, a
 * bubble's entry or a row filters the whole pane on that destination (the
 * pane's own `set('dest')`, handed in as `onSelect`), and Escape clears it.
 * With the pane's `filters` (egressMapContract.ts) the map also shows and
 * sets the kind filter, and the list's group headers the region filter;
 * without them the card still draws everything else.
 *
 * ── Never pretend a destination was placed ────────────────────────────────
 * A destination without a known location is listed under "No known
 * location" with the reason the server gave, so the map never understates
 * where data went. A destination on your own server or network sits at the
 * origin: it did not go anywhere.
 */

import { Info } from 'lucide-react';
import React, { useMemo, useState } from 'react';

import { useTranslation, type TranslateFn } from '../../../../../../../hooks/useTranslation';
import { listRows } from './destinationGroups';
import { DestinationList } from './DestinationList';
import type { EgressMapFilters } from './egressMapContract';
import { MapCanvas } from './MapCanvas';
import {
    placeDestinations, toMapDestinations, unplacedReason, type MapOrigin, type RawDestination, type UnplacedDestination,
} from './mapModel';
import { useWorldAtlas } from './useWorldAtlas';

export interface RawOrigin { lat?: number | string | null; lon?: number | string | null; label?: string | null; country_code?: string | null; country_name?: string | null }

interface Props {
    /** Every destination for the map (the overview's `map.destinations`, ≤200). */
    mapDestinations: RawDestination[];
    /** The busiest few for the list (the overview's `top.destinations`). */
    listDestinations: RawDestination[];
    origin: RawOrigin | null | undefined;
    attribution?: { text?: string | null; url?: string | null } | null;
    geoDb?: { available?: boolean | null } | null;
    selected: string | null;
    onSelect: (host: string) => void;
    /** No longer used here: the "hold kinds back from tools" advice lives in the pane's findings. Accepted so callers still type-check. */
    onGoTo?: (pane: string) => void;
    /** Cross-filter state and sample detail from the pane — see egressMapContract.ts. */
    filters?: EgressMapFilters;
    t: TranslateFn;
}

/** A usable origin, or null: an unset BEEFLOW_SERVER_LOCATION draws pins without lines. */
export function toOrigin(raw: RawOrigin | null | undefined): MapOrigin | null {
    if (!raw) return null;
    const lat = Number(raw.lat);
    const lon = Number(raw.lon);
    if (raw.lat === null || raw.lon === null || raw.lat === undefined || raw.lon === undefined) return null;
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
    return { lat, lon, label: raw.label || null, country_code: raw.country_code || null, country_name: raw.country_name || null };
}

export default function EgressMapCard({
    mapDestinations, listDestinations, origin: rawOrigin, attribution, geoDb, selected, onSelect, filters, t,
}: Props) {
    const { resolvedLocale } = useTranslation();
    const atlas = useWorldAtlas();
    const [hovered, setHovered] = useState<string | null>(null);

    const dests = useMemo(() => toMapDestinations(mapDestinations), [mapDestinations]);
    const busiest = useMemo(() => toMapDestinations(listDestinations), [listDestinations]);
    const origin = useMemo(() => toOrigin(rawOrigin), [rawOrigin]);

    // Which ones the map cannot place, and whether anything was placed at all.
    // Until the pins are in, only a destination with no known location is
    // certain to be unplaced: a country-only one would briefly read as one.
    const where = useMemo(
        () => (atlas ? placeDestinations(dests, atlas.pins, lonLat => lonLat) : null),
        [atlas, dests],
    );
    const unplaced: UnplacedDestination[] = useMemo(
        () => where?.unplaced || dests.filter(d => d.state === 'unknown').map(d => ({ ...d, reason: unplacedReason(d) })),
        [where, dests],
    );
    const rows = useMemo(() => listRows(busiest, unplaced), [busiest, unplaced]);
    const reasons = useMemo(() => (where ? new Map(where.unplaced.map(d => [d.host, d.reason])) : null), [where]);

    const showAttribution = !!geoDb?.available && !!attribution?.text;

    return (
        <div
            className="flex flex-col min-w-0"
            onKeyDown={(e) => {
                if (e.key !== 'Escape') return;
                setHovered(null);
                if (selected) onSelect(selected);
            }}
        >
            <div className="px-[18px] pb-3.5 flex flex-col gap-2">
                <MapCanvas
                    atlas={atlas}
                    dests={dests}
                    origin={origin}
                    selected={selected}
                    hovered={hovered}
                    onHover={setHovered}
                    onSelect={onSelect}
                    filters={filters}
                    locale={resolvedLocale}
                    t={t}
                />
                {!origin && !!where && where.placed.length > 0 && (
                    <p className="text-[11px] leading-4 m-0 text-[var(--text-secondary)]">
                        {t('egress_map.no_origin',
                            'Your server\'s location is not set, so the map shows where data went without drawing lines from your server. An administrator can set BEEFLOW_SERVER_LOCATION to add them.')}
                    </p>
                )}
            </div>

            <DestinationList
                items={rows}
                unplaced={reasons}
                selected={selected}
                hovered={hovered}
                onHover={setHovered}
                onSelect={onSelect}
                filters={filters}
                t={t}
            />

            <MapFootnote attribution={showAttribution ? attribution : null} t={t} />
        </div>
    );
}

/**
 * How a location is determined, how to read the bars, and the credit the
 * geolocation database asks for. The footnote is load-bearing: it tells an
 * admin what a pin claims (the IP the data went to) and what it does not
 * (who runs it).
 */
function MapFootnote({ attribution, t }: { attribution: Props['attribution'] | null; t: TranslateFn }) {
    return (
        <p className="flex gap-[7px] items-start m-0 px-[18px] py-2.5 border-t border-[var(--border-subtle)] text-[11px] leading-4 text-[var(--text-tertiary)]">
            <Info className="w-3 h-3 shrink-0 mt-0.5" aria-hidden="true" />
            <span>
                {t('egress_map.footnote',
                    'The location comes from the actual connection: the IP address the data went to, not who runs the service. A global network such as Cloudflare is shown at its edge, where your data entered it.')}
                {' '}
                {t('egress_map.footnote_bar', 'The darker part of each bar is the calls that carried personal data.')}
                {attribution?.text && (
                    <>
                        {' '}
                        <a
                            href={attribution.url || undefined}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="underline hover:text-[var(--text-secondary)]"
                        >
                            {attribution.text}
                        </a>
                    </>
                )}
            </span>
        </p>
    );
}
