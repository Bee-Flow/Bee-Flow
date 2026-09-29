/**
 * One destination in the list under the map: its host, where it is and who
 * runs it, a note when the map cannot show it plainly, what kind of call it
 * was (when the fetched calls say), a bar of its calls with the personal-data
 * part darker, and the count. Hovering lights up its pin; a click filters the
 * whole pane on it.
 */

import { Info } from 'lucide-react';
import React, { useId } from 'react';

import type { TranslateFn } from '../../../../../../../hooks/useTranslation';
import { fNum } from '../../../../../../../pages/settings/usage/format';
import { REGION_FILL } from '../../shieldPalette';
import type { DestinationType } from './egressMapContract';
import type { RowBar } from './destinationGroups';
import { howWeKnow, placeLabel, reasonLabel, shortLocation } from './locationCopy';
import type { MapDestination, UnplacedReason } from './mapModel';

/** The list's four columns; shared with its header so they line up. Two on a narrow card. */
export const LIST_COLUMNS = 'grid gap-3 items-center grid-cols-[minmax(0,1fr)_minmax(56px,96px)_40px] @xl:grid-cols-[minmax(0,1fr)_92px_220px_44px]';

interface Props {
    d: MapDestination;
    bar: RowBar;
    /** Why the map has no pin for it, if that is so. */
    missing: UnplacedReason | null;
    type: DestinationType | undefined;
    selected: boolean;
    lit: boolean;
    onHover: (host: string | null) => void;
    onSelect: (host: string) => void;
    t: TranslateFn;
}

function whereLine(d: MapDestination, t: TranslateFn): string {
    const where = d.state === 'local'
        ? t('admin.shield_activity_own_server', 'your own server')
        : placeLabel(d, t) || shortLocation(d, t);
    return [where, d.operator].filter(Boolean).join(' · ');
}

/** The blue line under a row: how a network edge was seen, or why there is no pin. Never a claim about the vendor. */
function noteFor(d: MapDestination, missing: UnplacedReason | null, t: TranslateFn): string | null {
    if (missing) return reasonLabel(missing, t);
    if (d.state === 'via_network') return howWeKnow(d, t);
    return null;
}

function TypePill({ type, t }: { type: DestinationType | undefined; t: TranslateFn }) {
    if (!type) return null;
    return (
        <span className="text-[10px] font-semibold px-[7px] py-0.5 rounded-full border border-[var(--border-default)] text-[var(--text-secondary)] whitespace-nowrap">
            {type === 'web_search' ? t('egress_map.type_web_search', 'Web search') : t('egress_map.type_tool', 'Tool')}
        </span>
    );
}

/** The track, the row's calls in a tint of its region, and the personal-data part in the region colour. */
function Bar({ bar, colour }: { bar: RowBar; colour: string }) {
    const clip = useId();
    return (
        <svg className="block w-full h-2 min-w-0" aria-hidden="true">
            <clipPath id={clip}><rect width="100%" height="8" rx="3" /></clipPath>
            <g clipPath={`url(#${clip})`}>
                <rect width="100%" height="8" fill="var(--bg-secondary)" />
                <rect width={`${(bar.calls * 100).toFixed(2)}%`} height="8" fill={colour} fillOpacity={0.22} />
                <rect width={`${(bar.pii * 100).toFixed(2)}%`} height="8" fill={colour} />
            </g>
        </svg>
    );
}

export function DestinationRow({ d, bar, missing, type, selected, lit, onHover, onSelect, t }: Props) {
    const note = noteFor(d, missing, t);
    return (
        <button
            type="button"
            onClick={() => onSelect(d.host)}
            onMouseEnter={() => onHover(d.host)}
            onMouseLeave={() => onHover(null)}
            onFocus={() => onHover(d.host)}
            onBlur={() => onHover(null)}
            aria-pressed={selected}
            aria-label={t('admin.shield_activity_filter_dest', 'Filter on {host}', { host: d.host })}
            data-lit={lit || undefined}
            className={`${LIST_COLUMNS} w-full text-left py-2 pl-[34px] pr-[18px] border-t border-[var(--border-subtle)] text-[13px] transition-colors hover:bg-[color-mix(in_srgb,var(--text-primary)_4%,transparent)] data-[lit]:bg-[color-mix(in_srgb,var(--text-primary)_5%,transparent)] aria-pressed:bg-[color-mix(in_srgb,var(--info-ink)_7%,transparent)] aria-pressed:shadow-[inset_3px_0_0_var(--info-ink)] focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[var(--info)]`}
        >
            <span className="min-w-0">
                <span className="block truncate font-mono text-xs text-[var(--text-primary)]">{d.host}</span>
                <span className="block truncate text-[11px] text-[var(--text-tertiary)]">{whereLine(d, t)}</span>
                {note && (
                    <span className="flex gap-[5px] items-start mt-1 text-[11px] leading-[15px] text-[var(--info-ink)]">
                        <Info className="w-[11px] h-[11px] shrink-0 mt-0.5" aria-hidden="true" />
                        <span>{note}</span>
                    </span>
                )}
            </span>
            <span className="hidden @xl:block"><TypePill type={type} t={t} /></span>
            <span className="flex items-center gap-2 min-w-0">
                <Bar bar={bar} colour={REGION_FILL[d.state]} />
                <span className="min-w-[34px] shrink-0 whitespace-nowrap text-[11px] text-[var(--text-tertiary)] tabular-nums">
                    {t('egress_map.pd', '{m} pd', { m: fNum(d.piiEvents) })}
                </span>
            </span>
            <span className="text-right font-semibold tabular-nums text-[var(--text-primary)]">{fNum(d.total)}</span>
        </button>
    );
}
