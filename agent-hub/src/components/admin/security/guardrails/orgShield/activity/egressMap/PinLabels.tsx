/**
 * The host name and a short "what went there" line beside a pin. Which pins
 * get one, what it says and where it goes is mapLabels.ts; this file only
 * gathers the candidates from the drawn clusters and turns the result into
 * SVG text. Decoration only: the pin's own aria-label and the tooltip carry
 * the same facts, so the text is hidden from assistive technology.
 */

import React, { useMemo } from 'react';

import type { TranslateFn } from '../../../../../../../hooks/useTranslation';
import { REGION_TEXT_FILL } from '../../shieldPalette';
import { clusterRadius, isMuted, type KindFocus } from './MapLayers';
import {
    kindCount, LABEL_H, mergeKinds, placeLabels, showsLabel, subLine,
    type LabelCandidate, type LabelObstacle, type PlacedLabel,
} from './mapLabels';
import { applyZoom, type Size, type ZoomState } from './mapGeometry';
import { MUTED_FILL, ORIGIN_FILL, type DestinationCluster } from './mapModel';
import type { MapModel } from './useMapModel';

export const ORIGIN_LABEL_KEY = '__origin__';
/** The kind pills cover the map's top strip, the legend and the hint its bottom one. */
const OVERLAY_INSETS = { top: 40, bottom: 44 };

interface Props {
    model: MapModel;
    clusters: DestinationCluster[];
    transform: ZoomState;
    size: Size;
    selected: string | null;
    focus: KindFocus;
    catLabel: (id: string) => string;
    t: TranslateFn;
}

interface Built { candidates: LabelCandidate[]; obstacles: LabelObstacle[]; colours: Map<string, string> }

/** Every single pin that wants a label, plus your server once zoomed in. */
function buildCandidates({ model, clusters, transform, selected, focus, catLabel, t }: Props): Built {
    const { kind, hostKinds } = focus;
    const colours = new Map<string, string>();
    const candidates: LabelCandidate[] = [];
    const obstacles: LabelObstacle[] = clusters.map(c => ({ key: c.key, at: c.at, r: clusterRadius(c, model.maxTotal) }));
    for (const c of clusters) {
        if (c.members.length !== 1) continue;
        const d = c.members[0];
        const kinds = hostKinds[d.host] || null;
        const n = kind ? kindCount(kinds, kind) : d.total;
        const isSelected = selected === d.host;
        if (!showsLabel({ n, k: transform.k, kindFilter: !!kind, selected: isSelected })) continue;
        colours.set(c.key, isMuted(d.host, focus) ? MUTED_FILL : REGION_TEXT_FILL[d.state]);
        candidates.push({
            key: c.key, at: c.at, r: clusterRadius(c, model.maxTotal), host: d.host,
            sub: subLine({ piiEvents: d.piiEvents, kinds }, kind, catLabel, t), force: isSelected, weight: n,
        });
    }
    if (model.origin && showsLabel({ n: model.localCalls, k: transform.k, kindFilter: !!kind, selected: false, origin: true })) {
        const local = model.placement.local;
        const at = applyZoom(model.origin, transform);
        obstacles.push({ key: ORIGIN_LABEL_KEY, at, r: 6 });
        colours.set(ORIGIN_LABEL_KEY, ORIGIN_FILL);
        candidates.push({
            key: ORIGIN_LABEL_KEY, at, r: 6, host: t('egress_map.place_local', 'Your server'), weight: model.localCalls,
            // Nothing stayed local: just the name, not a "no personal data" about no calls.
            sub: model.localCalls > 0
                ? subLine({ piiEvents: local.reduce((s, d) => s + d.piiEvents, 0), kinds: mergeKinds(local.map(d => d.host), hostKinds) }, kind, catLabel, t)
                : '',
        });
    }
    return { candidates, obstacles, colours };
}

function Label({ label, colour }: { label: PlacedLabel; colour: string }) {
    const top = label.box[0][1];
    const halo = { stroke: 'var(--bg-secondary)', strokeWidth: 3, strokeLinejoin: 'round' as const, paintOrder: 'stroke' };
    return (
        <g>
            <text x={label.x} y={top + 11} textAnchor={label.anchor} fontSize={11} fontWeight={600} fill={colour} {...halo}>{label.host}</text>
            {label.sub && (
                <text x={label.x} y={top + LABEL_H - 3} textAnchor={label.anchor} fontSize={10} fontWeight={500} fill="var(--text-secondary)" {...halo}>{label.sub}</text>
            )}
        </g>
    );
}

export function PinLabels(props: Props) {
    const { model, clusters, transform, size, selected, focus, catLabel, t } = props;
    const built = useMemo(
        () => buildCandidates({ model, clusters, transform, size, selected, focus, catLabel, t }),
        [model, clusters, transform, size, selected, focus, catLabel, t],
    );
    const placed = useMemo(() => placeLabels(built.candidates, size, built.obstacles, OVERLAY_INSETS), [built, size]);
    if (!placed.length) return null;
    return (
        <g aria-hidden="true" pointerEvents="none" className="select-none">
            {placed.map(l => <Label key={l.key} label={l} colour={built.colours.get(l.key) || MUTED_FILL} />)}
        </g>
    );
}
