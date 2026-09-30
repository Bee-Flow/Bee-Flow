/**
 * The tier dial's geometry, identical to the web's TierSlider
 * (agent-hub/src/components/licensing/TierSlider.jsx): the gauge's arc, the
 * track's stop positions, the fill's ink mix and where the panel opens. Pure,
 * so the numbers can be pinned without drawing anything.
 */

// ── Gauge ───────────────────────────────────────────────────────────────────
export const GAUGE_START_DEG = -135;
export const GAUGE_SWEEP_DEG = 270;
export const GAUGE_RADIUS = 8.5;
export const GAUGE_ARC_LEN = (GAUGE_SWEEP_DEG / 360) * 2 * Math.PI * GAUGE_RADIUS;

export interface Point {
    x: number;
    y: number;
}

export function polarPoint(center: Point, r: number, deg: number): Point {
    const rad = ((deg - 90) * Math.PI) / 180;
    return { x: center.x + r * Math.cos(rad), y: center.y + r * Math.sin(rad) };
}

export function arcPath(center: Point, r: number, fromDeg: number, toDeg: number): string {
    const start = polarPoint(center, r, fromDeg);
    const end = polarPoint(center, r, toDeg);
    const largeArc = Math.abs(toDeg - fromDeg) > 180 ? 1 : 0;
    return `M ${start.x.toFixed(2)} ${start.y.toFixed(2)} A ${r} ${r} 0 ${largeArc} 1 ${end.x.toFixed(2)} ${end.y.toFixed(2)}`;
}

/**
 * Where the gauge's needle points, 0–1 along the REAL depths only. Auto is a
 * choice on the track but not a depth; excluding it puts Fast at the floor and
 * Deep Thinking at the ceiling. Null when the tier is not on the scale.
 */
export function depthFraction(stops: readonly string[], value: string): number | null {
    const scale = stops.filter((k) => k !== 'auto');
    const index = scale.indexOf(value);
    if (index < 0) return null;
    return scale.length > 1 ? index / (scale.length - 1) : 1;
}

// ── Track ───────────────────────────────────────────────────────────────────
export const THUMB_PAD = 20;
export const THUMB_RADIUS = 14;
export const TRACK_HEIGHT = 40;
export const LABEL_WIDTH = 84;

/**
 * The fill darkens with travel: 20% ink at the shallow end, 44% at Deep
 * Thinking — the web's FILL_MIN_END_PCT / FILL_MAX_END_PCT. Mixed from the
 * theme's own ink into its own track surface, never from the accent: the
 * accent defaults to a grey that looks foreign on the warm Paper/Sepia themes,
 * while ink-over-surface belongs to any theme by construction.
 */
const FILL_MIN_END_PCT = 20;
const FILL_MAX_END_PCT = 44;

function hexChannel(hex: string, i: number): number {
    return parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16);
}

/** JS stand-in for CSS `color-mix(in srgb, ink pct%, surface)`. */
export function inkMix(ink: string, surface: string, pct: number): string {
    // nosemgrep: ajinabraham.njsscan.dos.regex_dos.regex_dos -- anchored, fixed length: # and exactly six hex digits, nothing to backtrack over
    if (!/^#[0-9a-fA-F]{6}$/.test(ink) || !/^#[0-9a-fA-F]{6}$/.test(surface)) return surface;
    const t = pct / 100;
    const ch = (i: number) => Math.round(hexChannel(ink, i) * t + hexChannel(surface, i) * (1 - t));
    return `rgb(${ch(0)}, ${ch(1)}, ${ch(2)})`;
}

/** The fill colour for the active stop's travel along the track. */
export function fillColor(ink: string, surface: string, activeIndex: number, count: number): string {
    const travel = activeIndex > 0 && count > 1 ? activeIndex / (count - 1) : 0;
    return inkMix(ink, surface, FILL_MIN_END_PCT + (FILL_MAX_END_PCT - FILL_MIN_END_PCT) * travel);
}

/** Horizontal centre of stop `i` in px, given the measured track width. */
export function stopCenter(i: number, count: number, width: number): number {
    if (count < 2) return width / 2;
    return THUMB_PAD + (width - THUMB_PAD * 2) * (i / (count - 1));
}

/** The stop nearest a touch at `locationX`. */
export function indexFromX(locationX: number, count: number, width: number): number {
    if (count < 2 || width === 0) return 0;
    const usable = Math.max(1, width - THUMB_PAD * 2);
    const ratio = Math.min(1, Math.max(0, (locationX - THUMB_PAD) / usable));
    return Math.round(ratio * (count - 1));
}

// ── Panel ───────────────────────────────────────────────────────────────────

/**
 * Where the panel opens: centred over the gauge and nudged back inside the
 * viewport (the web's edgeNudge), anchored by its BOTTOM edge 8px above the
 * trigger so its height never needs measuring.
 */
export function panelFrame(
    anchor: Point | null,
    screen: { width: number; height: number },
): { left: number; bottom: number; width: number } {
    const width = Math.min(320, screen.width - 16);
    if (!anchor) return { left: 8, bottom: 8, width };
    return {
        left: Math.min(Math.max(8, anchor.x + 17 - width / 2), screen.width - 8 - width),
        bottom: Math.max(8, screen.height - anchor.y + 8),
        width,
    };
}
