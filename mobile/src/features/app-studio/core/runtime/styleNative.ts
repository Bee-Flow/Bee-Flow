/**
 * NodeLayout / SectionLayout (styleResolver.ts) -> React Native styles.
 *
 * The web's runtime.css and CSS variables become an explicit AppStyleTheme,
 * so this stays pure: the renderer passes the app theme and the window width.
 * Where the web used something RN cannot draw, the nearest honest thing:
 *
 *   calc(n * 4px * var(--app-space))  -> n * SPACE_STEP_PX * density
 *   gridColumn span                   -> a percentage width of the row, the
 *                                        gap split into cell padding (the row
 *                                        pulls back by half a gap each side);
 *                                        below 640 wide every cell is full
 *                                        width (runtime.css's phone stack)
 *   width px/pct                      -> on the box inside the cell, capped
 *                                        at 100% (span keeps the placement)
 *   'gradient' background             -> the primary tint (no gradients in RN)
 *   color-mix(… 55%, text-primary)    -> mixHex
 *   'vh'                              -> a share of the window height
 *   app-hide-below/above-<band>       -> hiddenAt(); bands sm 640, md 1024,
 *                                        lg 1280 as in runtime.css, never on
 *                                        the editor canvas
 */

import type { TextStyle, ViewStyle } from 'react-native';

import {
    ROLE_HEX,
    SPACE_STEP_PX,
    roleText,
    type ColorRef,
    type HeightRule,
    type NodeLayout,
    type RadiusRef,
    type SectionLayout,
    type SizeSpec,
} from './styleResolver';

export interface AppStyleTheme {
    /** The density multiplier (--app-space). */
    density: number;
    /** The theme corner radius in px (--app-radius). */
    radius: number;
    colors: {
        primary: string;
        primarySoft: string;
        textPrimary: string;
        textSecondary: string;
        bgCard: string;
        border: string;
    };
    window: { width: number; height: number };
}

export const HIDE_BAND_PX: Readonly<Record<string, number>> = { sm: 640, md: 1024, lg: 1280 };
/** Below this width every cell takes the whole row. */
export const PHONE_STACK_PX = 640;

export const spacePx = (steps: number, theme: Pick<AppStyleTheme, 'density'>): number =>
    steps > 0 ? steps * SPACE_STEP_PX * (Number.isFinite(theme.density) ? theme.density : 1) : 0;

function channels(hex: string): [number, number, number] {
    const n = parseInt(hex.slice(1, 7), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** `color-mix(in srgb, a pct%, b)` for two #rrggbb colours. */
export function mixHex(a: string, b: string, pct: number): string {
    const [ar, ag, ab] = channels(a);
    const [br, bg, bb] = channels(b);
    const w = pct / 100;
    const mix = (x: number, y: number) => Math.round(x * w + y * (1 - w)).toString(16).padStart(2, '0');
    return `#${mix(ar, br)}${mix(ag, bg)}${mix(ab, bb)}`;
}

/** A #rrggbb colour at `pct`% opacity (color-mix with transparent). */
export function fadeHex(hex: string, pct: number): string {
    const [r, g, b] = channels(hex);
    return `rgba(${r}, ${g}, ${b}, ${pct / 100})`;
}

export function colorOf(ref: ColorRef, theme: AppStyleTheme): string {
    if ('hex' in ref) return ref.hex;
    if (ref.role === 'primary') return theme.colors.primary;
    if (ref.role === 'neutral') return theme.colors.textSecondary;
    return ROLE_HEX[ref.role];
}

/** A role colour used as text (see roleText). */
export function roleTextColor(tone: unknown, theme: AppStyleTheme): string {
    const { color, mixed } = roleText(tone);
    const base = colorOf(color, theme);
    return mixed ? mixHex(base, theme.colors.textPrimary, 55) : base;
}

const radiusPx = (ref: RadiusRef, theme: AppStyleTheme): number => ('px' in ref ? ref.px : theme.radius);

function sizeValue(spec: SizeSpec, theme: AppStyleTheme): ViewStyle['height'] {
    if (spec.unit === 'px') return spec.value;
    if (spec.unit === 'pct') return `${spec.value}%`;
    return Math.round((theme.window.height * spec.value) / 100);
}

function heightStyle(rule: HeightRule, theme: AppStyleTheme): ViewStyle {
    if (!rule) return {};
    if ('explicit' in rule) return { height: sizeValue(rule.explicit, theme), minHeight: 0, overflow: 'scroll' };
    if ('fill' in rule) return { flexGrow: 1, flexShrink: 1, flexBasis: 0, minHeight: 0, minWidth: 0 };
    return { height: rule.presetPx, overflow: 'scroll' };
}

/** Is the node hidden at this window width? Never on the editor canvas. */
export function hiddenAt(layout: Pick<NodeLayout, 'hideBelow' | 'hideAbove'>, width: number, editing = false): boolean {
    if (editing) return false;
    const below = layout.hideBelow ? HIDE_BAND_PX[layout.hideBelow] : undefined;
    const above = layout.hideAbove ? HIDE_BAND_PX[layout.hideAbove] : undefined;
    return (below !== undefined && width < below) || (above !== undefined && width >= above);
}

/** The span a cell actually takes at this window width. */
export const effectiveSpan = (span: number, width: number): number => (width < PHONE_STACK_PX ? 12 : span);

function backgroundColor(kind: NodeLayout['background'], theme: AppStyleTheme): string | undefined {
    if (kind === 'surface' || kind === 'panel') return theme.colors.bgCard;
    if (kind === 'tint' || kind === 'gradient') return theme.colors.primarySoft;
    return undefined;
}

function borderStyle(border: NodeLayout['border'], theme: AppStyleTheme): ViewStyle {
    if (border === 'default') return { borderWidth: 1, borderColor: theme.colors.border };
    if (border === 'subtle') return { borderWidth: 1, borderColor: fadeHex(theme.colors.border, 55) };
    return {};
}

function cellStyle(layout: NodeLayout, theme: AppStyleTheme, gapPx: number): ViewStyle {
    const span = effectiveSpan(layout.span, theme.window.width);
    return { width: `${(span / 12) * 100}%`, paddingHorizontal: gapPx / 2, minWidth: 0 };
}

function textStyle(layout: NodeLayout, theme: AppStyleTheme, baseFontSize: number): TextStyle {
    const text: TextStyle = {};
    if (layout.align) text.textAlign = layout.align;
    if (layout.fontWeight) text.fontWeight = String(layout.fontWeight) as TextStyle['fontWeight'];
    if (layout.fontScale) text.fontSize = Math.round(baseFontSize * layout.fontScale * 100) / 100;
    if (layout.color) text.color = colorOf(layout.color, theme);
    return text;
}

export interface NodeStyleOptions {
    /** The section's gap in px (sectionStyleNative's gapPx). */
    gapPx?: number;
    /** The inherited font size the size knob scales. */
    baseFontSize?: number;
}

/** A node's cell (placement), box (surface, size, spacing) and text styles. */
export function nodeStyleNative(
    layout: NodeLayout,
    theme: AppStyleTheme,
    { gapPx = 0, baseFontSize = 14 }: NodeStyleOptions = {},
): { cell: ViewStyle; box: ViewStyle; text: TextStyle; hidden: boolean } {
    const box: ViewStyle = { ...heightStyle(layout.height, theme) };
    if (layout.width) Object.assign(box, { width: sizeValue(layout.width, theme), maxWidth: '100%' });
    if (layout.radius !== undefined) box.borderRadius = radiusPx(layout.radius, theme);
    else if (layout.roundByBackground) box.borderRadius = theme.radius;
    if (layout.paddingSteps) box.padding = spacePx(layout.paddingSteps, theme);
    const bg = backgroundColor(layout.background, theme);
    if (bg) box.backgroundColor = bg;
    // A surface gets a hairline edge unless the border knob spoke.
    Object.assign(box, layout.border ? borderStyle(layout.border, theme) : layout.surface ? borderStyle('subtle', theme) : {});
    return {
        cell: cellStyle(layout, theme, gapPx),
        box,
        text: textStyle(layout, theme, baseFontSize),
        hidden: hiddenAt(layout, theme.window.width),
    };
}

/**
 * A section: the outer box (padding, surface, height) and the row that wraps
 * its cells (the 12-column flow; half a gap pulled back on each side because
 * every cell pads itself by half a gap). gapPx goes to nodeStyleNative.
 */
export function sectionStyleNative(
    layout: SectionLayout,
    theme: AppStyleTheme,
): { outer: ViewStyle; row: ViewStyle; gapPx: number } {
    const gapPx = spacePx(layout.gapSteps, theme);
    const outer: ViewStyle = { padding: spacePx(layout.paddingSteps, theme), ...heightStyle(layout.height, theme) };
    const bg = backgroundColor(layout.background, theme);
    if (bg) outer.backgroundColor = bg;
    if (layout.rounded) outer.borderRadius = theme.radius;
    if (layout.surface) Object.assign(outer, borderStyle('subtle', theme));
    const row: ViewStyle = { flexDirection: 'row', flexWrap: 'wrap', rowGap: gapPx, marginHorizontal: -gapPx / 2 };
    return { outer, row, gapPx };
}
