/**
 * What the colours on the map mean, in the map's bottom-left corner. HTML
 * rather than SVG text, so it wraps on a phone instead of running off the
 * card, and so a screen reader reads it as a list.
 *
 * "Via a global network" stays a region of its own: its pin is the network's
 * edge, not the service, and the map draws its line dotted for that reason.
 */

import React from 'react';

import type { TranslateFn } from '../../../../../../../hooks/useTranslation';
import { REGION_BG } from '../../shieldPalette';

export function MapLegend({ t, showOrigin }: { t: TranslateFn; showOrigin: boolean }) {
    const items: Array<[string, string]> = [
        ...(showOrigin ? [[REGION_BG.local, t('egress_map.place_local', 'Your server')] as [string, string]] : []),
        [REGION_BG.eu, t('egress_map.legend_inside', 'Inside Europe')],
        [REGION_BG.outside, t('egress_map.legend_outside', 'Outside Europe')],
        [REGION_BG.via_network, t('egress_map.legend_network', 'Via a global network')],
    ];
    return (
        <ul
            aria-label={t('egress_map.legend_label', 'Map legend')}
            className="absolute left-2.5 bottom-2.5 z-10 m-0 list-none flex flex-wrap gap-x-3 gap-y-0.5 px-2.5 py-1.5 rounded-lg max-w-[calc(100%-20px)] @3xl:max-w-[calc(100%-320px)] bg-[color-mix(in_srgb,var(--bg-card)_92%,transparent)] text-[11px] leading-4 text-[var(--text-secondary)]"
        >
            {items.map(([swatch, label]) => (
                <li key={label} className="inline-flex items-center gap-[5px]">
                    <span aria-hidden="true" className={`w-[9px] h-[9px] rounded-[2px] shrink-0 ${swatch}`} />
                    <span>{label}</span>
                </li>
            ))}
        </ul>
    );
}
