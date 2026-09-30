/**
 * App Studio runtime: what a node's or section's style knobs DECIDE, without
 * the CSS. Port of the value logic of agent-hub AppStudio/runtime/
 * styleResolver.js, pinned by styleResolver.lockstep.test.ts, which rebuilds
 * the web's exact { className, style } from these descriptors.
 *
 * The web translates knobs straight to CSS strings (calc(), var(), grid
 * spans, media-query classes). The phone has none of those, so this module
 * stops one step earlier and returns plain data; styleNative.ts turns it into
 * React Native styles against the theme. The mappings:
 *
 *   span 1..12          -> `span` (the RN grid lays out a 12-column row)
 *   padding/gap steps   -> `*Steps`; 1 step = SPACE_STEP_PX x density
 *   colour role / hex   -> ColorRef ({ role } or { hex }), themed later
 *   radius              -> RadiusRef ({ theme } or { px })
 *   height preset       -> px (HEIGHT_PX); 'fill' -> flex: 1
 *   width/height modes  -> { unit: 'px' | 'pct' | 'vh', value }
 *   background          -> its kind; 'panel' also elevates, 'panel' and
 *                          'gradient' also round with the theme radius
 *   hideBelow/hideAbove -> the band names, for a width-aware renderer
 */

export const SPACE_STEP_PX = 4;

export type ColorRole = 'primary' | 'neutral' | 'success' | 'warning' | 'danger' | 'info';
export type ColorRef = { role: ColorRole } | { hex: string };
export type RadiusRef = { theme: true } | { px: number };
export type SizeUnit = 'px' | 'pct' | 'vh';
export interface SizeSpec {
    unit: SizeUnit;
    value: number;
}
export type Background = 'surface' | 'tint' | 'panel' | 'gradient';
export type Border = 'default' | 'subtle';
export type HeightRule = { explicit: SizeSpec } | { fill: true } | { presetPx: number } | null;

/** The status hexes the roles use (the web's ROLE_COLORS; primary and neutral follow the theme). */
export const ROLE_HEX: Readonly<Record<'success' | 'warning' | 'danger' | 'info', string>> = {
    success: '#10b981',
    warning: '#f59e0b',
    danger: '#ef4444',
    info: '#0ea5e9',
};
const ROLES: readonly string[] = ['primary', 'neutral', 'success', 'warning', 'danger', 'info'];

/** A foreground for a fill of a role colour (same answer as the web). */
export const roleFillContrast = (tone: unknown): string =>
    tone === 'danger' || tone === 'primary' ? '#ffffff' : '#111827';

/**
 * A role colour used as TEXT: the role (unknown tones fall back to primary)
 * and whether it is mixed 55% into the primary text colour, which keeps the
 * hue while the lightness follows the theme. Primary and neutral are not mixed.
 */
export function roleText(tone: unknown): { color: ColorRef; mixed: boolean } {
    const role = (ROLES.includes(tone as string) ? tone : 'primary') as ColorRole;
    return { color: { role }, mixed: tone !== 'neutral' && tone !== 'primary' };
}

const HEX_RE = /^#[0-9a-fA-F]{6}$/;

/** colorOrRole knob value -> a colour reference, or null to inherit. */
export function resolveColor(value: unknown): ColorRef | null {
    if (value == null) return null;
    if (typeof value === 'string' && ROLES.includes(value)) return { role: value as ColorRole };
    if (typeof value === 'string' && HEX_RE.test(value)) return { hex: value };
    return null;
}

export const RADIUS_PX: Readonly<Record<string, number>> = { none: 0, sm: 4, md: 8, lg: 12, full: 9999 };

/** radius knob: undefined when absent, the theme radius for null/unknown. */
export function resolveRadius(value: unknown): RadiusRef | undefined {
    if (value === undefined) return undefined;
    const px = typeof value === 'string' && Object.prototype.hasOwnProperty.call(RADIUS_PX, value) ? RADIUS_PX[value] : undefined;
    return px === undefined ? { theme: true } : { px };
}

export const ALIGN_VALUES: Readonly<Record<string, 'left' | 'center' | 'right'>> = { start: 'left', center: 'center', end: 'right' };
export const WEIGHT_VALUES: Readonly<Record<string, 400 | 500 | 600>> = { regular: 400, medium: 500, semibold: 600 };
/** Font size as a multiple of the inherited size; md is the inherited size itself. */
export const FONT_SCALE: Readonly<Record<string, number>> = { sm: 0.875, lg: 1.125 };
export const HEIGHT_PX: Readonly<Record<string, number>> = { sm: 120, md: 200, lg: 320, xl: 620 };

const own = <T>(map: Readonly<Record<string, T>>, key: unknown): T | undefined =>
    typeof key === 'string' && Object.prototype.hasOwnProperty.call(map, key) ? map[key] : undefined;

/** The authored span, coerced into 1..12 (missing = full width). */
export function clampSpan(span: unknown): number {
    return Number.isFinite(span) ? Math.max(1, Math.min(12, span as number)) : 12;
}

/** height preset -> px, or null (auto, fill and unknown carry no fixed size). */
export function resolveHeight(value: unknown): number | null {
    if (!value || value === 'auto' || value === 'fill') return null;
    return own(HEIGHT_PX, value) ?? null;
}

type Style = Record<string, unknown> | null | undefined;
const sizeNumber = (v: unknown): number | null => (Number.isFinite(v) ? Math.round(v as number) : null);

/** widthMode/widthValue -> an explicit width, or null when the grid (span) owns it. */
export function resolveWidth(s: Style): SizeSpec | null {
    const mode = s && s.widthMode;
    if (mode !== 'px' && mode !== 'pct') return null;
    const n = sizeNumber(s?.widthValue);
    return n === null ? null : { unit: mode, value: n };
}

/** heightMode/heightValue -> an explicit height, or null when the preset owns it. */
export function resolveHeightSpec(s: Style): SizeSpec | null {
    const mode = s && s.heightMode;
    if (mode !== 'px' && mode !== 'pct' && mode !== 'vh') return null;
    const n = sizeNumber(s?.heightValue);
    return n === null ? null : { unit: mode, value: n };
}

/** A SECTION's explicit height: px and vh only (a percentage has nothing to measure). */
export function resolveSectionHeightSpec(s: Style): SizeSpec | null {
    if (s && s.heightMode === 'pct') return null;
    return resolveHeightSpec(s);
}

export function resolveBackground(value: unknown): Background | null {
    return value === 'surface' || value === 'tint' || value === 'panel' || value === 'gradient' ? value : null;
}

export function resolveBorder(value: unknown): Border | null {
    return value === 'default' || value === 'subtle' ? value : null;
}

/** True when this node asked to take the leftover space (an explicit height outranks it). */
export function isFill(node: { style?: Style } | null | undefined): boolean {
    return !resolveHeightSpec(node?.style) && node?.style?.height === 'fill';
}

function heightRule(s: Record<string, unknown>, explicit: SizeSpec | null): HeightRule {
    if (explicit) return { explicit };
    if (s.height === 'fill') return { fill: true };
    const px = resolveHeight(s.height);
    return px ? { presetPx: px } : null;
}

const HIDE_BANDS = ['sm', 'md', 'lg'];
const band = (v: unknown): string | null => (HIDE_BANDS.includes(v as string) ? (v as string) : null);
const positiveSteps = (v: unknown): number | null => (Number.isFinite(v) && (v as number) > 0 ? (v as number) : null);

export interface NodeLayout {
    span: number;
    width: SizeSpec | null;
    align: 'left' | 'center' | 'right' | null;
    fontWeight: 400 | 500 | 600 | null;
    fontScale: number | null;
    height: HeightRule;
    color: ColorRef | null;
    radius: RadiusRef | undefined;
    paddingSteps: number | null;
    background: Background | null;
    /** 'panel': the elevated band (semantic elevation 1). */
    elevated: boolean;
    /** 'panel'/'gradient' take the theme radius unless the radius knob spoke. */
    roundByBackground: boolean;
    border: Border | null;
    /** A surface-coloured node gets a hairline edge unless `border` spoke. */
    surface: boolean;
    hideBelow: string | null;
    hideAbove: string | null;
}

/** What a node's style knobs decide. Only knobs present on node.style have an effect. */
export function resolveNodeLayout(node: { style?: Style } | null | undefined): NodeLayout {
    const s = (node && node.style) || {};
    const background = resolveBackground(s.background);
    const radius = resolveRadius(s.radius);
    const decorated = background === 'panel' || background === 'gradient';
    return {
        span: clampSpan(s.span),
        width: resolveWidth(s),
        align: own(ALIGN_VALUES, s.align) ?? null,
        fontWeight: own(WEIGHT_VALUES, s.weight) ?? null,
        fontScale: own(FONT_SCALE, s.size) ?? null,
        height: heightRule(s, resolveHeightSpec(s)),
        color: resolveColor(s.color),
        radius,
        paddingSteps: positiveSteps(s.padding),
        background,
        elevated: background === 'panel',
        roundByBackground: decorated && radius === undefined,
        border: resolveBorder(s.border),
        surface: background === 'surface' || background === 'panel',
        hideBelow: band(s.hideBelow),
        hideAbove: band(s.hideAbove),
    };
}

export interface SectionLayout {
    gapSteps: number;
    paddingSteps: number;
    height: HeightRule;
    background: Background | null;
    /** Any background rounds the section with the theme radius. */
    rounded: boolean;
    elevated: boolean;
    surface: boolean;
}

/** What a section's style knobs decide (defaults: gap 3 steps, no padding). */
export function resolveSectionLayout(section: { style?: Style } | null | undefined): SectionLayout {
    const s = (section && section.style) || {};
    const background = resolveBackground(s.background);
    return {
        gapSteps: Number.isFinite(s.gap) ? (s.gap as number) : 3,
        paddingSteps: Number.isFinite(s.padding) ? (s.padding as number) : 0,
        height: heightRule(s, resolveSectionHeightSpec(s)),
        background,
        rounded: background !== null,
        elevated: background === 'panel',
        surface: background === 'panel',
    };
}

/**
 * For a container that fills its height: its children (indices) in 12-column
 * rows, and which row takes the slack: the first row holding a filling child,
 * else the last row. Every other row keeps its content height.
 */
export function fillRows(node: { children?: { style?: Style }[] } | null | undefined): { rows: number[][]; growRow: number } {
    const kids = Array.isArray(node?.children) ? node.children : [];
    const rows: number[][] = [];
    let used = 0;
    kids.forEach((kid, i) => {
        const raw = Number(kid?.style?.span);
        const span = Math.min(12, Math.max(1, Number.isFinite(raw) ? raw : 12));
        if (rows.length === 0 || used + span > 12) {
            rows.push([i]);
            used = span;
        } else {
            (rows[rows.length - 1] as number[]).push(i);
            used += span;
        }
    });
    let growRow = rows.findIndex((row) => row.some((i) => isFill(kids[i])));
    if (growRow < 0) growRow = Math.max(0, rows.length - 1);
    return { rows, growRow };
}
