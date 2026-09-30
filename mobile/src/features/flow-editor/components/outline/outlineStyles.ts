/**
 * The outline's look: the web step card's recipe (StepNodeBase, via
 * model/familyStyle.ts) as themed styles, one precomputed style per family,
 * status and depth — so a row picks styles and never builds one inline.
 */

import type { TextStyle, ViewStyle } from 'react-native';

import { perTheme, type Theme } from '@/core/theme/ThemeProvider';
import { cardChrome, statusColor, typeTile, type StatusTone } from '@/features/flow-editor/model';
import { tint } from '@/shared/ui';

import { byKey, FAMILY_KEYS, familyOf, LANE_TONES, toneColors, type FamilyKey } from './styleKeys';

/** How far one level of nesting indents. */
export const INDENT = 18;
/** Deepest indent drawn; anything deeper sits at this depth. */
export const MAX_DEPTH = 8;

const STATUS_TONES: readonly StatusTone[] = ['success', 'error', 'ai', 'warning', 'pinned'];
const STATUS_OF: Record<StatusTone, string> = { success: 'success', error: 'error', ai: 'running', warning: 'awaiting_approval', pinned: 'pinned' };

/** The tile's corner per family: a branch is a diamond, the shield rounder, an end card a block. */
function tileStyle(theme: Theme, key: FamilyKey, error = false): ViewStyle {
    const tile = typeTile(theme, familyOf(key), { error });
    const radius = tile.shape === 'circle' ? 17 : tile.shape === 'shield' ? 12 : tile.shape === 'diamond' ? 6 : 9;
    return {
        backgroundColor: tile.background,
        borderRadius: radius,
        ...(tile.shape === 'diamond' ? { transform: [{ rotate: '45deg' }], width: 26, height: 26 } : null),
    };
}

const buildOutlineStyles = (theme: Theme) => ({
    list: { paddingTop: theme.spacing[3], paddingBottom: 120 } satisfies ViewStyle,
    indent: Array.from({ length: MAX_DEPTH + 1 }, (_, d): ViewStyle => ({
        paddingLeft: theme.spacing[4] + d * INDENT,
        paddingRight: theme.spacing[4],
    })),
    card: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.spacing[2.5],
        minHeight: 72,
        paddingVertical: theme.spacing[2],
        paddingLeft: theme.spacing[3.5],
        paddingRight: theme.spacing[1],
        borderRadius: theme.radii.md,
        borderWidth: 1,
        borderColor: theme.colors.borderDefault,
        backgroundColor: theme.colors.bgCard,
        overflow: 'hidden',
    } satisfies ViewStyle,
    pressed: { backgroundColor: theme.colors.itemHoverBg } satisfies ViewStyle,
    // The 4px family bar on the leading edge (never a border: the border is the run status's).
    bar: { position: 'absolute', left: 0, top: 0, bottom: 0, width: 4 } satisfies ViewStyle,
    barColor: byKey(FAMILY_KEYS, (k): ViewStyle => ({ backgroundColor: cardChrome(theme, { group: familyOf(k) }).bar })),
    barError: { backgroundColor: theme.colors.error } satisfies ViewStyle,
    triggerEdge: { borderTopLeftRadius: 22, borderBottomLeftRadius: 22 } satisfies ViewStyle,
    endEdge: { borderTopRightRadius: 22, borderBottomRightRadius: 22 } satisfies ViewStyle,
    loopBorder: { borderStyle: 'dashed', borderWidth: 1.5, borderColor: theme.stepType.loop } satisfies ViewStyle,
    statusBorder: byKey(STATUS_TONES, (tone): ViewStyle => {
        const color = statusColor(theme, STATUS_OF[tone]) ?? theme.colors.borderDefault;
        return { borderColor: color, borderWidth: 1.5, boxShadow: `0 0 0 3px ${tint(color, 22)}` };
    }),
    skipped: { borderStyle: 'dashed', opacity: 0.7 } satisfies ViewStyle,
    disabledCard: { borderStyle: 'dashed', borderColor: theme.colors.textTertiary, opacity: 0.55 } satisfies ViewStyle,
    tileBox: { width: 34, height: 34, alignItems: 'center', justifyContent: 'center' } satisfies ViewStyle,
    tile: { width: 34, height: 34, alignItems: 'center', justifyContent: 'center' } satisfies ViewStyle,
    tileColor: byKey(FAMILY_KEYS, (k) => tileStyle(theme, k)),
    tileError: tileStyle(theme, 'end', true),
    glyph: byKey(FAMILY_KEYS, (k) => ({ color: typeTile(theme, familyOf(k)).color })),
    glyphError: { color: typeTile(theme, 'end', { error: true }).color },
    unrotate: { transform: [{ rotate: '-45deg' }] } satisfies ViewStyle,
    body: { flex: 1, minWidth: 0, gap: 1 } satisfies ViewStyle,
    kicker: { fontSize: 11, letterSpacing: 0.5, textTransform: 'uppercase' } satisfies TextStyle,
    kickerColor: byKey(FAMILY_KEYS, (k): TextStyle => ({ color: cardChrome(theme, { group: familyOf(k) }).bar })),
    kickerError: { color: theme.colors.errorInk } satisfies TextStyle,
    name: { fontSize: 15, lineHeight: 20 } satisfies TextStyle,
    muted: { fontStyle: 'italic' } satisfies TextStyle,
    side: { alignItems: 'flex-end', gap: theme.spacing[1], flexShrink: 0 } satisfies ViewStyle,
    chips: { flexDirection: 'row', gap: theme.spacing[1], flexWrap: 'wrap', justifyContent: 'flex-end' } satisfies ViewStyle,
    menuGlyph: { color: theme.colors.textTertiary },
    // Rows between the cards.
    lane: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing[1.5], paddingTop: theme.spacing[3], paddingBottom: theme.spacing[1] } satisfies ViewStyle,
    laneDot: { width: 8, height: 8, borderRadius: 4 } satisfies ViewStyle,
    laneTone: byKey(LANE_TONES, (tone): ViewStyle => ({ backgroundColor: toneColors(theme, tone).raw })),
    group: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing[2], minHeight: theme.minTouch } satisfies ViewStyle,
    groupGlyph: { color: theme.stepType.loop },
    add: { flexDirection: 'row', alignItems: 'center', minHeight: 44 } satisfies ViewStyle,
    addPressed: { backgroundColor: theme.colors.itemActiveBg, borderColor: theme.colors.accentPrimary } satisfies ViewStyle,
    addLine: { position: 'absolute', left: 17, top: 0, bottom: 0, width: 2, backgroundColor: theme.colors.borderSubtle } satisfies ViewStyle,
    addButton: {
        width: 28, height: 28, marginLeft: 4, borderRadius: 14, alignItems: 'center', justifyContent: 'center',
        backgroundColor: theme.colors.bgSecondary, borderWidth: 1, borderColor: theme.colors.borderDefault,
    } satisfies ViewStyle,
    addEnd: {
        flexDirection: 'row', alignItems: 'center', gap: theme.spacing[2], minHeight: 40, marginVertical: theme.spacing[1],
        paddingHorizontal: theme.spacing[3], borderRadius: theme.radii.md, borderWidth: 1, borderStyle: 'dashed',
        borderColor: theme.colors.borderDefault,
    } satisfies ViewStyle,
    addGlyph: { color: theme.colors.textSecondary },
    jump: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing[1.5], minHeight: 36 } satisfies ViewStyle,
    jumpGlyph: { color: theme.colors.textTertiary },
    section: {
        paddingHorizontal: theme.spacing[4], paddingTop: theme.spacing[5], paddingBottom: theme.spacing[1],
    } satisfies ViewStyle,
    sectionText: { letterSpacing: 0.55, textTransform: 'uppercase' } satisfies TextStyle,
});

export type OutlineStyles = ReturnType<typeof makeOutlineStyles>;

/** A row's indent, clamped to the deepest level drawn. */
export const indentFor = (styles: OutlineStyles, depth: number): ViewStyle =>
    styles.indent[Math.max(0, Math.min(MAX_DEPTH, depth))] as ViewStyle;

/** Built once per theme: every outline row and canvas node asks for it (see perTheme). */
export const makeOutlineStyles = perTheme(buildOutlineStyles);
