/**
 * Where an edge's chip ("3 of 4 records") sits, in flow units.
 *
 * At the midpoint, as LabelledEdge has always put it, except on an edge that
 * leaves a node with NAMED ports (a Condition's "Match" / "Otherwise", a
 * split's "pdf" / "word" / "Otherwise"). layout.js sets `data.fromPortLabels`
 * on exactly those edges.
 *
 * Spec C4 asked for the chip centred at clamp(labelX, sourceX + 88, targetX - 40).
 * On the canvas that never worked, for two reasons the screenshots showed:
 * the chip is not the centre of what LabelledEdge positions (the cluster is
 * chip + "+" + two hover buttons that keep their room while invisible, so a
 * centred cluster puts the chip ~40 px LEFT of the anchor), and cards sit 80
 * apart, so between a port and the next card there are about 60 units: the
 * clamp's two bounds cross and the chip lands on the port names regardless.
 *
 * So out of a named port the resting cluster starts just past the port pill,
 * on the port's own line (sourceY), and grows to the right. Where the gap is
 * too narrow for the whole chip it shows the count alone ("4"); the whole label
 * is its tooltip and comes back the moment you point at the line.
 */
export const PORT_LABEL_ROOM = 88;
export const TARGET_ROOM = 40;

/** How far a port pill reaches past its handle (StepNodeBase's port row), plus a hair. */
export const PORT_PILL_CLEAR = 26;

/**
 * The narrowest gap (flow units, at scale 1) between a port handle and the
 * next card that holds the pill clearance, a whole "11 records" chip and the
 * arrowhead. Below it the chip shrinks to its count.
 */
export const FULL_CHIP_MIN_GAP = 112;

/** The spec's centred anchor; still the rule for an edge whose source has no named ports. */
export function chipAnchorX(labelX: number, sourceX: number, targetX: number, fromPortLabels: boolean): number {
    if (!fromPortLabels) return labelX;
    return Math.min(Math.max(labelX, sourceX + PORT_LABEL_ROOM), targetX - TARGET_ROOM);
}

export interface ChipPlacement {
    x: number;
    y: number;
    /** 'start': `x` is the cluster's LEFT edge; 'center': its centre. */
    align: 'start' | 'center';
    /** Too little room for the whole chip: show the count alone. */
    compact: boolean;
}

export interface ChipGeometry {
    labelX: number;
    labelY: number;
    sourceX: number;
    sourceY: number;
    targetX: number;
}

/**
 * The cluster's resting place. `scale` is the counter-zoom the edge applies to
 * it, so a zoomed-out canvas (a bigger chip in flow units) goes compact sooner.
 */
export function chipPlacement(geo: ChipGeometry, fromPortLabels: boolean, scale = 1): ChipPlacement {
    if (!fromPortLabels) return { x: geo.labelX, y: geo.labelY, align: 'center', compact: false };
    return {
        x: geo.sourceX + PORT_PILL_CLEAR,
        y: geo.sourceY,
        align: 'start',
        compact: geo.targetX - geo.sourceX < FULL_CHIP_MIN_GAP * scale,
    };
}

/** The compact chip's text: the count alone, or the whole label when there is no count. */
export function compactChipText(summary: { count?: unknown; label?: unknown } | null | undefined): string {
    const count = summary?.count;
    if (typeof count === 'number' && Number.isFinite(count)) return String(count);
    return typeof summary?.label === 'string' ? summary.label : '';
}
