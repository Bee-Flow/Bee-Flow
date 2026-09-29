/**
 * The card that appears next to a hovered or focused pin: where the data
 * went, who runs it, how much went, which kinds of data, and HOW WE KNOW.
 * That last line is the point of the tooltip: an edge of a global network and
 * the service behind it are different claims, and the map has to say which
 * one it is making.
 *
 * The kinds come from the fetched calls, not the whole period (see
 * egressMapContract.ts), and the tooltip says so above them.
 *
 * Positioned from a measurement (its own size against the card's), so the
 * position is written to the element in a layout effect before paint rather
 * than held in state: nothing about it is styling.
 */

import React, { useLayoutEffect, useRef } from 'react';

import type { TranslateFn } from '../../../../../../../hooks/useTranslation';
import { fNum } from '../../../../../../../pages/settings/usage/format';
import { howWeKnow, placeLabel, relativeAgo } from './locationCopy';
import type { HostKinds } from './mapLabels';
import { tooltipPosition, type Pt, type Size } from './mapGeometry';
import type { MapDestination } from './mapModel';

interface Props {
    id: string;
    anchor: Pt;
    box: Size;
    /** A destination, or null for your server itself. */
    dest: MapDestination | null;
    /** Kinds in the fetched calls to it, when it is in them. */
    kinds?: HostKinds | null;
    catLabel?: (id: string) => string;
    /** For your server: its label and the calls that stayed local. */
    originLabel?: string | null;
    localCalls?: number;
    locale?: string;
    t: TranslateFn;
}

const MUTED = 'text-[color-mix(in_srgb,rgb(from_var(--bg-card)_r_g_b_/_1)_72%,var(--text-primary))]';
const RULE = 'mt-1.5 pt-1.5 border-t border-[color-mix(in_srgb,var(--bg-card)_15%,transparent)]';

export function MapTooltip({ id, anchor, box, dest, kinds, catLabel, originLabel, localCalls = 0, locale, t }: Props) {
    const ref = useRef<HTMLDivElement>(null);

    useLayoutEffect(() => {
        const el = ref.current;
        if (!el) return;
        const [x, y] = tooltipPosition(anchor, { w: el.offsetWidth, h: el.offsetHeight }, box);
        el.style.transform = `translate(${x}px, ${y}px)`;
    });

    return (
        <div
            ref={ref}
            id={id}
            role="tooltip"
            className="pointer-events-none absolute left-0 top-0 z-20 w-[260px] max-w-[calc(100%-12px)] rounded-[9px] bg-[var(--text-primary)] px-2.5 py-2 text-[11px] leading-4 text-[rgb(from_var(--bg-card)_r_g_b_/_1)] shadow-[var(--shadow-lg)]"
        >
            {dest ? <DestinationBody dest={dest} kinds={kinds || null} catLabel={catLabel} locale={locale} t={t} /> : (
                <>
                    <p className="m-0 font-semibold">{t('egress_map.place_local', 'Your server')}</p>
                    {originLabel && <p className={`m-0 ${MUTED}`}>{originLabel}</p>}
                    <p className="m-0 mt-1">
                        {t('egress_map.origin_calls', '{n} calls stayed on your own server or network', { n: fNum(localCalls) })}
                    </p>
                </>
            )}
        </div>
    );
}

/** One row per kind: its name, a bar against the most frequent one, and the count. */
function KindRows({ kinds, catLabel, t }: { kinds: HostKinds; catLabel: (id: string) => string; t: TranslateFn }) {
    const max = Math.max(1, ...kinds.map(([, n]) => n));
    return (
        <div className={RULE}>
            <p className={`m-0 mb-0.5 ${MUTED}`}>{t('egress_map.tip_kinds', 'Kinds of data, in the most recent calls')}</p>
            {kinds.map(([kind, n]) => (
                <div key={kind} className="grid grid-cols-[minmax(0,1fr)_60px_24px] gap-1.5 items-center">
                    <span className="truncate">{catLabel(kind)}</span>
                    <svg width="60" height="4" aria-hidden="true" className="block">
                        <rect width="60" height="4" rx="2" fill="var(--bg-card)" fillOpacity={0.2} />
                        <rect width={Math.max(2, (60 * n) / max)} height="4" rx="2" fill="var(--bg-card)" />
                    </svg>
                    <span className="text-right tabular-nums font-semibold">{fNum(n)}</span>
                </div>
            ))}
        </div>
    );
}

function DestinationBody({ dest, kinds, catLabel, locale, t }: {
    dest: MapDestination; kinds: HostKinds | null; catLabel?: (id: string) => string; locale?: string; t: TranslateFn;
}) {
    const place = placeLabel(dest, t);
    const who = dest.operator || dest.asOrg;
    const when = relativeAgo(dest.lastContact, locale);
    return (
        <>
            <p className="m-0 font-semibold text-[12px] break-all font-mono">{dest.host}</p>
            {(place || who) && <p className={`m-0 ${MUTED}`}>{[place, who].filter(Boolean).join(' · ')}</p>}
            <p className="m-0 mt-1 tabular-nums">
                {dest.piiEvents > 0
                    ? t('egress_map.calls_pii', '{n} calls · {m} with personal data', { n: fNum(dest.total), m: fNum(dest.piiEvents) })
                    : t('egress_map.calls', '{n} calls', { n: fNum(dest.total) })}
            </p>
            {kinds && kinds.length > 0 && catLabel && <KindRows kinds={kinds} catLabel={catLabel} t={t} />}
            <div className={RULE}>
                {when && <p className={`m-0 ${MUTED}`}>{t('egress_map.last_contact', 'Last contact {when}', { when })}</p>}
                <p className="m-0">
                    <span className="font-semibold">{t('egress_map.how_label', 'How we know')}: </span>
                    <span className={MUTED}>{howWeKnow(dest, t)}</span>
                </p>
            </div>
        </>
    );
}
