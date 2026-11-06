export type DeltaUnit = 'pct' | 'pts' | 'abs';
export type DeltaDirection = 'up' | 'down' | 'same';

export interface FormattedDelta {
    direction: DeltaDirection;
    text: string;
}

export interface DeltaLabels {
    same: string;
    pts: string;
}

const DEFAULT_LABELS: DeltaLabels = { same: 'same', pts: 'pts' };

/**
 * "↓ 51%", "↑ 50 pts", "↑ 3" or "same". A null or non-finite delta has no text
 * (no previous figure to compare with); a change that rounds to zero is "same".
 */
export function formatDelta(delta: number | null | undefined, unit: DeltaUnit, labels: DeltaLabels = DEFAULT_LABELS): FormattedDelta | null {
    if (delta == null || !Number.isFinite(delta)) return null;
    const magnitude = Math.round(Math.abs(delta));
    if (magnitude === 0) return { direction: 'same', text: labels.same };
    const direction: DeltaDirection = delta > 0 ? 'up' : 'down';
    const arrow = direction === 'up' ? '↑' : '↓';
    const suffix = unit === 'pct' ? '%' : unit === 'pts' ? ` ${labels.pts}` : '';
    return { direction, text: `${arrow} ${magnitude}${suffix}` };
}
