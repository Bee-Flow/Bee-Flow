/**
 * The canvas's look, as themed styles — one precomputed style per family and
 * tone, so a node picks styles and never builds one inline. The cards
 * themselves wear the outline's recipe (outline/outlineStyles.ts, through
 * outline/card/); this file adds what only the canvas draws: the
 * frame, the ports and their names, the compact tiles, an open loop's box
 * and its "Each item", notes, the lines' chips and buttons.
 *
 * Where a thing sits is the one style that cannot be precomputed: `boxAt`
 * and `dotAt` turn a world rect or point into its place in the world view.
 */

import type { TextStyle, ViewStyle } from 'react-native';

import { perTheme, type Theme } from '@/core/theme/ThemeProvider';
import { familyColor, type EdgeColorKey } from '@/features/flow-editor/model';
import { tint } from '@/shared/ui';

import type { ChipTone } from './chips';
import { EDGE_COLOR_HEX } from './edgeColors';
import type { Rect } from './viewport';
import { byKey, FAMILY_KEYS, familyOf, LANE_TONES, toneColors } from '../outline/styleKeys';

const CHIP_TONES: readonly ChipTone[] = [...LANE_TONES, 'unrouted'];
const NOTE_KEYS = Object.keys(EDGE_COLOR_HEX) as EdgeColorKey[];

export const PORT_DOT = 12;
export const PLUS = 26;

/** The frame, the nodes and their ports. */
const nodeStyles = (theme: Theme) => ({
    frame: { flex: 1, overflow: 'hidden', backgroundColor: theme.colors.bgPrimary } satisfies ViewStyle,
    world: { position: 'absolute', left: 0, top: 0, transformOrigin: 'left top' } satisfies ViewStyle,
    abs: { position: 'absolute' } satisfies ViewStyle,
    fill: { position: 'absolute', left: 0, top: 0, right: 0, bottom: 0 } satisfies ViewStyle,
    dimmed: { opacity: 0.35 } satisfies ViewStyle,
    lifted: { boxShadow: theme.shadows.lg, opacity: 0.92 } satisfies ViewStyle,
    picked: { boxShadow: `0 0 0 3px ${tint(theme.colors.accentPrimary, 55)}` } satisfies ViewStyle,
    // A card on the canvas: the outline card in a fixed box, room on the right for the port names
    // (its badges and port names sit outside it: the card clips, so its family bar keeps its corners).
    card: { minHeight: 0, paddingRight: theme.spacing[5] } satisfies ViewStyle,
    badgeSlot: { position: 'absolute', top: -9, right: 10 } satisfies ViewStyle,
    // The compact tile a card becomes below 60%.
    tile: { alignItems: 'center', justifyContent: 'center', borderRadius: theme.radii.md, borderWidth: 2 } satisfies ViewStyle,
    tileColor: byKey(FAMILY_KEYS, (k): ViewStyle => ({
        backgroundColor: tint(familyColor(theme, familyOf(k)), 20),
        borderColor: familyColor(theme, familyOf(k)),
    })),
    tileGlyph: byKey(FAMILY_KEYS, (k) => ({ color: familyColor(theme, familyOf(k)) })),
    // Ports: a ring on the edge; a branch port wears its name beside it.
    port: {
        position: 'absolute', width: PORT_DOT, height: PORT_DOT, borderRadius: PORT_DOT / 2, borderWidth: 2,
        borderColor: theme.colors.textTertiary, backgroundColor: theme.colors.bgPrimary,
    } satisfies ViewStyle,
    portPill: {
        position: 'absolute', height: 18, justifyContent: 'center', maxWidth: 120, paddingHorizontal: theme.spacing[2], borderRadius: theme.radii.pill,
        backgroundColor: theme.colors.bgPrimary,
    } satisfies ViewStyle,
    portPillTone: byKey(LANE_TONES, (tone): ViewStyle => ({ backgroundColor: tint(toneColors(theme, tone).raw, 18) })),
    portWords: byKey(LANE_TONES, (tone): TextStyle => ({ color: toneColors(theme, tone).ink, fontWeight: '700' })),
    // An open loop: dashed in the loop colour over a 5% wash, a header strip on top.
    container: {
        borderRadius: theme.radii.lg, borderWidth: 1.5, borderStyle: 'dashed', borderColor: theme.stepType.loop,
        backgroundColor: tint(theme.stepType.loop, 5),
    } satisfies ViewStyle,
    containerHeader: {
        flexDirection: 'row', alignItems: 'center', gap: theme.spacing[2], height: 46, paddingLeft: theme.spacing[3], paddingRight: 44,
        borderBottomWidth: 1, borderStyle: 'dashed', borderColor: theme.stepType.loop,
    } satisfies ViewStyle,
    loopWords: { color: theme.stepType.loop, letterSpacing: 0.8, textTransform: 'uppercase' } satisfies TextStyle,
    loopGlyph: { color: theme.stepType.loop },
    headerText: { flex: 1, minWidth: 0 } satisfies ViewStyle,
    // "Each item": a pill, not a card — it is not a step.
    entry: {
        flexDirection: 'row', alignItems: 'center', gap: theme.spacing[2], paddingHorizontal: theme.spacing[3], borderRadius: theme.radii.pill,
        borderWidth: 1, borderStyle: 'dashed', borderColor: theme.stepType.loop, backgroundColor: tint(theme.stepType.loop, 8),
    } satisfies ViewStyle,
    note: { padding: theme.spacing[2.5], borderRadius: theme.radii.sm, borderWidth: 1 } satisfies ViewStyle,
    noteColor: byKey(NOTE_KEYS, (k): ViewStyle => ({ backgroundColor: tint(EDGE_COLOR_HEX[k], 12), borderColor: tint(EDGE_COLOR_HEX[k], 50) })),
});

/** What sits over the nodes: the lines' chips and buttons, the loop toggles, connect targets. */
const chromeStyles = (theme: Theme) => ({
    // A line's chip sits on an opaque ground, so the line never runs through its words.
    chip: {
        paddingHorizontal: theme.spacing[1.5], borderRadius: theme.radii.pill, borderWidth: 1, backgroundColor: theme.colors.bgPrimary,
    } satisfies ViewStyle,
    chipTone: byKey(CHIP_TONES, (tone): ViewStyle => ({
        backgroundColor: tint(toneColors(theme, tone).raw, 15),
        borderColor: tint(toneColors(theme, tone).raw, 40),
        ...(tone === 'unrouted' ? { borderStyle: 'dashed' as const } : null),
    })),
    chipWords: byKey(CHIP_TONES, (tone): TextStyle => ({
        color: toneColors(theme, tone).ink, letterSpacing: 0.5, textTransform: 'uppercase', ...(tone === 'default' ? { fontStyle: 'italic' as const } : null),
    })),
    // "+" on a line or a free port; "×" on a line in connect mode.
    plus: {
        width: PLUS, height: PLUS, borderRadius: PLUS / 2, alignItems: 'center', justifyContent: 'center',
        backgroundColor: theme.colors.accentPrimary, boxShadow: theme.shadows.sm,
    } satisfies ViewStyle,
    plusGlyph: { color: theme.colors.accentPrimaryFg },
    remove: {
        width: PLUS, height: PLUS, borderRadius: PLUS / 2, alignItems: 'center', justifyContent: 'center',
        backgroundColor: theme.colors.bgPrimary, borderWidth: 1, borderColor: tint(theme.colors.error, 60),
    } satisfies ViewStyle,
    removeGlyph: { color: theme.colors.error },
    cluster: { position: 'absolute', flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: theme.spacing[1.5] } satisfies ViewStyle,
    loopChipRow: { flexDirection: 'row', alignItems: 'flex-start' } satisfies ViewStyle,
    loopChip: {
        flexDirection: 'row', alignItems: 'center', gap: theme.spacing[1], height: 24, paddingHorizontal: theme.spacing[2],
        borderRadius: theme.radii.pill, borderWidth: 1, borderColor: theme.stepType.loop, backgroundColor: theme.colors.bgCard,
    } satisfies ViewStyle,
    target: {
        borderRadius: 14, borderWidth: 2, borderColor: theme.colors.accentPrimary, backgroundColor: tint(theme.colors.accentPrimary, 20),
    } satisfies ViewStyle,
    targetPicked: { backgroundColor: theme.colors.accentPrimary } satisfies ViewStyle,
    toggle: {
        width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center',
        backgroundColor: theme.colors.bgCard, borderWidth: 1, borderColor: theme.colors.borderDefault,
    } satisfies ViewStyle,
    toggleGlyph: { color: theme.colors.textSecondary },
    rubber: { position: 'absolute', height: 2, transformOrigin: 'left center', backgroundColor: theme.colors.accentPrimary } satisfies ViewStyle,
    line: { color: theme.colors.borderDefault },
});

/** Built once per theme: every node and edge asks for it as the culled patch moves (see perTheme). */
export const makeCanvasStyles = perTheme((theme: Theme) => ({ ...nodeStyles(theme), ...chromeStyles(theme) }));

export type CanvasStyles = ReturnType<typeof makeCanvasStyles>;

/** A world rect's place in the world view. */
export function boxAt(frame: Rect, r: { x: number; y: number; width: number; height: number }): ViewStyle {
    return { left: r.x - frame.x, top: r.y - frame.y, width: r.width, height: r.height };
}

/** An Svg's box drawn at resolution `res`, scaled back to its world size. */
export function scaledBox(bbox: { width: number; height: number }, res: number): ViewStyle {
    return { left: 0, top: 0, width: bbox.width * res, height: bbox.height * res, transform: [{ scale: 1 / res }], transformOrigin: 'left top' };
}

/** A `width` × `height` box centred on a world point. */
export function centred(frame: Rect, p: { x: number; y: number }, width: number, height: number): ViewStyle {
    return { left: p.x - frame.x - width / 2, top: p.y - frame.y - height / 2, width, height };
}

/** A square of `size` centred on a world point. */
export function dotAt(frame: Rect, x: number, y: number, size: number): ViewStyle {
    return { left: x - frame.x - size / 2, top: y - frame.y - size / 2, width: size, height: size };
}

/** A port's name pill: starting at x, centred on y (the pill is 18 tall). */
export function pillAt(x: number, y: number): ViewStyle {
    return { left: x, top: y - 9 };
}

/** A node-local square of `size` centred on (x, y). */
export function localDot(x: number, y: number, size: number): ViewStyle {
    return { left: x - size / 2, top: y - size / 2 };
}
