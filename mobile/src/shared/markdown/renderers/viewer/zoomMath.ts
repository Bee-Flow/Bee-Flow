/** The zoom viewer's limits, as worklets (they run on the UI thread with the gestures). */

export const MIN_SCALE = 1;
export const MAX_SCALE = 5;
export const DOUBLE_TAP_SCALE = 2.5;

export function clampScale(scale: number): number {
    'worklet';
    return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
}

/**
 * An offset along one axis, held inside the overhang: content `length` wide
 * at `scale` sticks out (scale − 1) × length / 2 on each side, and dragging
 * further would only show the backdrop.
 */
export function clampOffset(offset: number, length: number, scale: number): number {
    'worklet';
    const overhang = Math.max(0, ((scale - 1) * length) / 2);
    return Math.min(overhang, Math.max(-overhang, offset));
}
