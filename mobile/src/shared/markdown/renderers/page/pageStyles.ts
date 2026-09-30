/**
 * The page renderer's sheet: PageRenderer.jsx's inline styles at a phone's
 * type scale (its 0.9rem body is 14 here, its 1.75rem h1 is 24).
 */

import { StyleSheet, type TextStyle, type ViewStyle } from 'react-native';

import { perTheme, type Theme } from '@/core/theme/ThemeProvider';

const HEADINGS: Record<number, TextStyle> = {
    1: { fontSize: 24, lineHeight: 32, fontWeight: '700' },
    2: { fontSize: 20, lineHeight: 28, fontWeight: '600' },
    3: { fontSize: 17, lineHeight: 24, fontWeight: '600' },
    4: { fontSize: 15, lineHeight: 21, fontWeight: '600' },
    5: { fontSize: 14, lineHeight: 20, fontWeight: '500' },
    6: { fontSize: 12, lineHeight: 17, fontWeight: '500' },
};

export function pageHeading(level: number | null): TextStyle {
    return HEADINGS[level && level >= 1 && level <= 6 ? Math.round(level) : 2] as TextStyle;
}

/** A grid cell's share of the row: `columns` across, less the gaps. */
export function gridCell(columns: number): ViewStyle {
    const n = Math.max(1, Math.min(columns, 4));
    return { flexBasis: `${Math.floor(100 / n) - 4}%`, flexGrow: 1, minWidth: n > 2 ? 140 : 0 };
}

export function gapOf(gap: number | null): ViewStyle {
    return { gap: gap ?? 16 };
}

const ALIGNS = new Set(['flex-start', 'flex-end', 'center', 'stretch', 'baseline']);
const JUSTIFIES = new Set(['flex-start', 'flex-end', 'center', 'space-between', 'space-around', 'space-evenly']);

/** A row's `align` and `justify`, where they are values a flexbox knows (the web passes them to CSS as given). */
export function rowLayout(align: string, justify: string, gap: number | null): ViewStyle {
    return {
        gap: gap ?? 16,
        alignItems: ALIGNS.has(align) ? (align as ViewStyle['alignItems']) : 'stretch',
        justifyContent: JUSTIFIES.has(justify) ? (justify as ViewStyle['justifyContent']) : 'flex-start',
    };
}

export const pageSheet = perTheme((theme: Theme) =>
    StyleSheet.create({
        column: { gap: theme.spacing[4] },
        tight: { gap: theme.spacing[3] },
        wrap: { flexDirection: 'row', flexWrap: 'wrap' },
        sectionTitle: {
            fontSize: 17,
            lineHeight: 24,
            ...theme.fonts.semibold,
            color: theme.colors.textPrimary,
            paddingBottom: theme.spacing[2],
            borderBottomWidth: 1,
            borderBottomColor: theme.colors.borderSubtle,
        },
        card: {
            padding: theme.spacing[4],
            paddingTop: theme.spacing[4] + 3,
            gap: theme.spacing[3],
            borderRadius: theme.radii.lg,
            borderWidth: 1,
            borderColor: theme.colors.borderDefault,
            backgroundColor: theme.colors.bgSecondary,
            overflow: 'hidden',
            minWidth: 0,
        },
        cardBar: { position: 'absolute', top: 0, left: 0, right: 0 },
        cardTitle: { fontSize: 15, lineHeight: 21, ...theme.fonts.semibold, color: theme.colors.textPrimary },
        heading: { color: theme.colors.textPrimary },
        text: { fontSize: 14, lineHeight: 24, color: theme.colors.textSecondary },
        image: { width: '100%', borderRadius: theme.radii.md },
        divider: { borderTopWidth: 1, borderTopColor: theme.colors.borderSubtle, marginVertical: theme.spacing[2] },
        listItem: { flexDirection: 'row', gap: theme.spacing[2], paddingLeft: theme.spacing[2] },
        listMarker: { width: 18, fontSize: 14, lineHeight: 24, color: theme.colors.textSecondary, textAlign: 'right' },
        listBody: { flex: 1, minWidth: 0 },
        stat: {
            alignItems: 'center',
            padding: theme.spacing[4],
            borderRadius: theme.radii.lg,
            borderWidth: 1,
            borderColor: theme.colors.borderDefault,
            backgroundColor: theme.colors.bgSecondary,
        },
        statValue: { fontSize: 28, lineHeight: 34, fontWeight: '700', color: theme.colors.textPrimary },
        statLabel: { fontSize: 14, color: theme.colors.textMuted, textAlign: 'center' },
        statChange: { fontSize: 12, marginTop: theme.spacing[2] },
        badge: {
            alignSelf: 'flex-start',
            paddingHorizontal: theme.spacing[3],
            paddingVertical: theme.spacing[1],
            borderRadius: 999,
            backgroundColor: theme.colors.bgTertiary,
        },
        badgeText: { fontSize: 12, fontWeight: '500', color: theme.colors.textMuted },
        secondaryButton: { backgroundColor: theme.colors.bgTertiary },
        chartTitle: { fontSize: 14, ...theme.fonts.semibold, color: theme.colors.textPrimary },
        chartRow: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing[3] },
        chartLabel: { width: 80, fontSize: 13, color: theme.colors.textMuted },
        chartTrack: { flex: 1, height: 22, borderRadius: 999, backgroundColor: theme.colors.bgTertiary, overflow: 'hidden' },
        chartValue: { width: 48, fontSize: 13, fontWeight: '500', textAlign: 'right', color: theme.colors.textSecondary },
    }),
);

export type PageStyles = ReturnType<typeof pageSheet>;
