/**
 * The destinations under the map, grouped by where they are: your own
 * server, inside Europe, outside it, through a global network, and with no
 * known location. A group header filters the pane on its region; a row
 * filters it on that destination. Hovering a row lights up its pin, and
 * hovering a pin lights up its row.
 *
 * Which rows, which groups and how long each bar is: destinationGroups.ts.
 */

import React from 'react';

import type { TranslateFn } from '../../../../../../../hooks/useTranslation';
import { fNum } from '../../../../../../../pages/settings/usage/format';
import { REGION_BG, type Region } from '../../shieldPalette';
import { REGION_WORDS, wordFor } from '../activityLabels';
import { groupDestinations, missingReason, rowBar, type DestinationGroup } from './destinationGroups';
import { DestinationRow, LIST_COLUMNS } from './DestinationRow';
import type { EgressMapFilters } from './egressMapContract';
import type { MapDestination, UnplacedReason } from './mapModel';

interface Props {
    items: MapDestination[];
    /** Hosts the map could not place, with the reason; null until the map has loaded. */
    unplaced: Map<string, UnplacedReason> | null;
    selected: string | null;
    hovered: string | null;
    onHover: (host: string | null) => void;
    onSelect: (host: string) => void;
    filters?: EgressMapFilters;
    t: TranslateFn;
}

/** A region's name: the same words as the filter chip a header click creates. */
export function regionLabel(region: Region, t: TranslateFn): string {
    return wordFor(REGION_WORDS, region, t);
}

function GroupHeader({ group, first, filters, t }: { group: DestinationGroup; first: boolean; filters?: EgressMapFilters; t: TranslateFn }) {
    const body = (
        <>
            <span aria-hidden="true" className={`w-[9px] h-[9px] rounded-[3px] shrink-0 ${REGION_BG[group.region]}`} />
            <span className="font-semibold text-[var(--text-primary)]">{regionLabel(group.region, t)}</span>
            {group.calls !== null && (
                <span className="text-[var(--text-tertiary)] tabular-nums">
                    {group.pct !== null
                        ? t('egress_map.group_calls_pct', '{n} calls · {p}%', { n: fNum(group.calls), p: group.pct })
                        : t('egress_map.calls', '{n} calls', { n: fNum(group.calls) })}
                </span>
            )}
        </>
    );
    const frame = `w-full flex items-center gap-2 px-[18px] pt-2.5 pb-1.5 text-xs text-left ${first ? '' : 'border-t border-[var(--border-default)]'}`;
    // Without the pane's filters there is no region filter to set: a heading, not a button.
    if (!filters) return <div className={frame}>{body}</div>;
    return (
        <button
            type="button"
            aria-pressed={filters.selectedRegion === group.region}
            onClick={() => filters.onSelectRegion(group.region)}
            className={`${frame} hover:bg-[color-mix(in_srgb,var(--text-primary)_4%,transparent)] aria-pressed:bg-[var(--bg-secondary)] focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[var(--info)]`}
        >
            {body}
        </button>
    );
}

function ColumnHeader({ t }: { t: TranslateFn }) {
    return (
        <div className={`${LIST_COLUMNS} px-[18px] py-1.5 border-y border-[var(--border-default)] bg-[var(--bg-secondary)] text-[10px] tracking-[0.05em] uppercase font-bold text-[var(--text-tertiary)]`}>
            <span>{t('egress_map.col_destination', 'Destination')}</span>
            <span className="hidden @xl:block">{t('egress_map.col_type', 'Type')}</span>
            <span className="truncate">{t('egress_map.col_bar', 'Calls · with personal data')}</span>
            <span className="text-right">{t('egress_map.col_calls', 'Calls')}</span>
        </div>
    );
}

export function DestinationList({ items, unplaced, selected, hovered, onHover, onSelect, filters, t }: Props) {
    const groups = groupDestinations(items, filters?.regionTotals);
    const maxTotal = Math.max(0, ...items.map(d => d.total));
    return (
        <div className="@container flex flex-col min-w-0">
            <ColumnHeader t={t} />
            {groups.length === 0 && (
                <p className="m-0 px-[18px] py-3 text-[11px] text-[var(--text-tertiary)]">
                    {t('admin.shield_activity_no_destinations', 'No outgoing calls in this period.')}
                </p>
            )}
            {groups.map((g, i) => (
                <div key={g.region} role="group" aria-label={regionLabel(g.region, t)}>
                    <GroupHeader group={g} first={i === 0} filters={filters} t={t} />
                    {g.rows.map(d => (
                        <DestinationRow
                            key={d.host}
                            d={d}
                            bar={rowBar(d, maxTotal)}
                            missing={missingReason(d, unplaced)}
                            type={filters?.hostTypes?.[d.host]}
                            selected={selected === d.host}
                            lit={hovered === d.host}
                            onHover={onHover}
                            onSelect={onSelect}
                            t={t}
                        />
                    ))}
                </div>
            ))}
        </div>
    );
}
