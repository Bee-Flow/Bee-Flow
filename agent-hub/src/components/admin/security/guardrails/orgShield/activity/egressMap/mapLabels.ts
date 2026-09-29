/**
 * The words beside a pin, and where they go. Pure: `t` and the category
 * labels are injected, so the wording and the placement are tested on data
 * (mapLabels.test.ts) rather than on drawn SVG.
 *
 * ── Sample, not window ────────────────────────────────────────────────────
 * The kinds of data per destination come from the fetched call rows (see
 * egressMapContract.ts); the destination's own counts come from whatever the
 * pane handed the map. A host that is not in the sample has no kinds, and
 * then the label says only how many calls carried personal data, never
 * which kinds.
 *
 * ── Placement ─────────────────────────────────────────────────────────────
 * Greedy, most important first: the selected pin, then the busiest. Each
 * label tries right, left, below and above its pin and takes the first spot
 * that stays inside the map, clear of the strips the overlays cover (kind
 * pills on top, legend and hint below), and covers neither another label
 * nor another pin. A label with no free spot is left out; the tooltip still has it.
 */

import type { TranslateFn } from '../../../../../../../hooks/useTranslation';
import { fNum } from '../../../../../../../pages/settings/usage/format';
import type { Box, Pt, Size } from './mapGeometry';

/** Kinds found in a host's sampled calls, most first, as [category id, calls]. */
export type HostKinds = Array<[string, number]>;

/** From this zoom on, every pin gets its label. */
export const LABEL_ZOOM = 3;
/** Below LABEL_ZOOM, a pin needs this many calls for a label (the second with a kind filter on). */
export const LABEL_MIN_CALLS = 15;
export const LABEL_MIN_KIND_CALLS = 3;

/** How many of a host's sampled calls carried `kind`: 0 when it is not in the sample. */
export function kindCount(kinds: HostKinds | null | undefined, kind: string): number {
    return kinds?.find(([id]) => id === kind)?.[1] ?? 0;
}

/**
 * The kinds of several hosts together, most first: your server stands for
 * every destination on it. null when none of them is in the sample.
 */
export function mergeKinds(hosts: string[], hostKinds: Record<string, HostKinds> | null | undefined): HostKinds | null {
    const sum = new Map<string, number>();
    let seen = false;
    for (const host of hosts) {
        const kinds = hostKinds?.[host];
        if (!kinds) continue;
        seen = true;
        for (const [id, n] of kinds) sum.set(id, (sum.get(id) || 0) + n);
    }
    return seen ? [...sum.entries()].sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0])) : null;
}

export interface SubLineInput {
    /** Calls to this host that carried personal data, as the destination row says. */
    piiEvents: number;
    /** Kinds in the sampled calls to it, or null when the host is not in the sample. */
    kinds: HostKinds | null;
}

/** The small line under the host: what went there. */
export function subLine(input: SubLineInput, kind: string | null, catLabel: (id: string) => string, t: TranslateFn): string {
    if (!(input.piiEvents > 0)) return t('egress_map.label_no_pii', 'no personal data');
    if (kind) return t('egress_map.label_kind_n', '{n}× {kind}', { n: fNum(kindCount(input.kinds, kind)), kind: catLabel(kind) });
    const [top, ...rest] = input.kinds || [];
    if (!top) return t('egress_map.label_pii', '{m} with personal data', { m: fNum(input.piiEvents) });
    return rest.length
        ? t('egress_map.label_top_more', '{kind} +{k} more', { kind: catLabel(top[0]), k: rest.length })
        : catLabel(top[0]);
}

export interface LabelRule {
    /** Calls under the current filters: to the host, or of the filtered kind when one is on. */
    n: number;
    /** The current zoom. */
    k: number;
    kindFilter: boolean;
    selected: boolean;
    /** Your server: labelled only once zoomed in, it is where every line starts. */
    origin?: boolean;
}

export function showsLabel({ n, k, kindFilter, selected, origin = false }: LabelRule): boolean {
    if (selected) return true;
    if (origin) return k >= LABEL_ZOOM;
    return k >= LABEL_ZOOM || n >= (kindFilter ? LABEL_MIN_KIND_CALLS : LABEL_MIN_CALLS);
}

/* ── Placement ───────────────────────────────────────────────────────── */

export type LabelSide = 'R' | 'L' | 'B' | 'T';
export type TextAnchor = 'start' | 'middle' | 'end';

export interface LabelCandidate {
    key: string;
    /** Screen position of the pin. */
    at: Pt;
    /** The pin's radius. */
    r: number;
    host: string;
    sub: string;
    /** The selected pin: placed first, and placed even when every spot is taken. */
    force?: boolean;
    /** Higher goes first. */
    weight: number;
}

export interface PlacedLabel {
    key: string;
    host: string;
    sub: string;
    side: LabelSide;
    box: Box;
    /** Where the text starts, and how it is anchored there. */
    x: number;
    anchor: TextAnchor;
}

export interface LabelObstacle { key: string; at: Pt; r: number }

const SIDES: LabelSide[] = ['R', 'L', 'B', 'T'];
/** Rough glyph widths for 11px/600 and 10px/500 sans; generous, so a label never runs into the next. */
const HOST_CH = 6.3;
const SUB_CH = 5.4;
export const LABEL_H = 26;
const GAP = 4;

export function labelSize(host: string, sub: string): Size {
    return { w: Math.ceil(Math.max(host.length * HOST_CH, sub.length * SUB_CH)), h: LABEL_H };
}

function boxFor(side: LabelSide, c: LabelCandidate, size: Size): { box: Box; x: number; anchor: TextAnchor } {
    const [x, y] = c.at;
    const reach = c.r + GAP;
    if (side === 'R') return { box: [[x + reach, y - size.h / 2], [x + reach + size.w, y + size.h / 2]], x: x + reach, anchor: 'start' };
    if (side === 'L') return { box: [[x - reach - size.w, y - size.h / 2], [x - reach, y + size.h / 2]], x: x - reach, anchor: 'end' };
    const top = side === 'B' ? y + reach - 2 : y - reach + 2 - size.h;
    return { box: [[x - size.w / 2, top], [x + size.w / 2, top + size.h]], x, anchor: 'middle' };
}

const overlaps = (a: Box, b: Box) => a[0][0] < b[1][0] && b[0][0] < a[1][0] && a[0][1] < b[1][1] && b[0][1] < a[1][1];

function coversCircle(box: Box, o: LabelObstacle): boolean {
    const cx = Math.max(box[0][0], Math.min(o.at[0], box[1][0]));
    const cy = Math.max(box[0][1], Math.min(o.at[1], box[1][1]));
    return Math.hypot(o.at[0] - cx, o.at[1] - cy) < o.r;
}

/** How far a label keeps from each edge of the map. */
export interface LabelInsets { top?: number; bottom?: number; side?: number }

const inside = (box: Box, area: Size, { top = 4, bottom = 4, side = 4 }: LabelInsets) =>
    box[0][0] >= side && box[0][1] >= top && box[1][0] <= area.w - side && box[1][1] <= area.h - bottom;

export function placeLabels(candidates: LabelCandidate[], area: Size, obstacles: LabelObstacle[] = [], insets: LabelInsets = {}): PlacedLabel[] {
    const order = [...candidates].sort((a, b) => (Number(!!b.force) - Number(!!a.force)) || (b.weight - a.weight) || a.key.localeCompare(b.key));
    const placed: PlacedLabel[] = [];
    for (const c of order) {
        const size = labelSize(c.host, c.sub);
        const spots = SIDES.map(side => ({ side, ...boxFor(side, c, size) }));
        const free = spots.find(s => inside(s.box, area, insets)
            && !placed.some(p => overlaps(p.box, s.box))
            && !obstacles.some(o => o.key !== c.key && coversCircle(s.box, o)));
        const spot = free || (c.force ? spots.find(s => inside(s.box, area, insets)) || spots[0] : null);
        if (spot) placed.push({ key: c.key, host: c.host, sub: c.sub, side: spot.side, box: spot.box, x: spot.x, anchor: spot.anchor });
    }
    return placed;
}
