import type { Rect } from './useBuildChoreography.types';

export interface Shot { padding: number; minZoom: number; maxZoom: number; duration: number }

/**
 * The push-in's centre: 60 % the newest card, 40 % the frame, then clamped so
 * the bias only spends slack — when the whole frame fits it stays inside the
 * padding; when the zoom floor makes it overflow, at least the newest card
 * stays fully inside.
 */
export interface BiasTowardNewestArgs {
    zoom: number;
    px: number;
    py: number;
}

/**
 * One camera shot.
 *
 *   push — frames the union of `rects` plus the ghost slot at near LOD
 *          (minZoom 0.85, so the summary line is legible) and biases the centre
 *          60/40 toward the LAST rect, the newest card: the eye should land on
 *          what just arrived, not on the middle of the frame. The bias never
 *          pushes that card out of the padded frame.
 *   wide — the chapter-break fit, identical to `fitView({padding: 0.12,
 *          minZoom: 0.2, maxZoom: 1})` over cards + ghost.
 *
 * `interpolate` is 'smooth' (React Flow's zoom-out-and-in) unless the zoom
 * barely changes, when a linear pan reads better. Returns null when there is
 * nothing to frame or no viewport to frame it in.
 */
export interface ShotForArgs {
    kind?: string | undefined;
    rects?: Rect[];
    ghostRect?: Rect | undefined;
    viewport?: { width: number; height: number; offsetX: number; } | null;
    current?: { x: number; y: number; zoom: number; };
}

/**
 * Decide whether — and how — the camera moves for one event.
 *
 * Returns null when the camera must stay put: the presenter has taken it
 * (`following` false — it stays theirs until they press Follow) or the reason
 * is not one the film cuts on. Otherwise:
 *
 *   moves   — ['push'], ['wide'], or ['wide', 'push'] on a row wrap (the wide
 *             shot shows the new row, then the camera comes back in on its
 *             first card; a single fit on the pair would crop it).
 *   holdMs  — the gap to keep between the moves of this plan, and before any
 *             later one: WRAP_HOLD_MS on a wrap, otherwise MIN_MOVE_GAP_MS.
 *   deferMs — how long to wait before the FIRST move so that two moves are
 *             never closer than MIN_MOVE_GAP_MS; 0 when the hold has elapsed.
 */
export interface PlanCameraMoveArgs {
    reason?: string;
    following?: boolean | undefined;
    lastMoveAt?: number | null | undefined;
    now?: number | undefined;
    rowWrapped?: boolean | undefined;
}
