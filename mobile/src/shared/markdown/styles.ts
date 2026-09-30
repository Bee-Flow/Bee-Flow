/**
 * The Markdown sheet, from the web's `.markdown-content` rules
 * (agent-hub/src/index.css) on the app's tokens: headings a step above body at
 * weight 600, list indents of 1.25rem (1.5rem for numbers), blue medium-weight
 * links, the red-tinted inline code chip, a 3px accent bar on quotes, and
 * bordered tables with a tinted header row.
 *
 * Built once per theme (perTheme): every block of every message asks for it.
 */

import { StyleSheet } from 'react-native';

import { perTheme, type Theme } from '@/core/theme/ThemeProvider';
import { tint } from '@/shared/ui';

/** The heading sizes, h1–h6: the web's 1.35/1.15/1.05/0.95rem over a 15px body. */
const HEADING_SIZES = [20, 18, 16, 15, 14, 13] as const;

export function headingSize(depth: number): number {
    return HEADING_SIZES[Math.min(Math.max(depth, 1), 6) - 1] as number;
}

function build(theme: Theme) {
    const { colors, spacing, type, fonts, radii } = theme;
    return StyleSheet.create({
        root: { gap: spacing[1.5] },
        text: { ...type.body, color: colors.textPrimary },
        heading: { ...fonts.semibold, color: colors.textPrimary, marginTop: spacing[1] },
        strong: { ...fonts.semibold },
        em: { fontStyle: 'italic' },
        del: { textDecorationLine: 'line-through' },
        imageAlt: { color: colors.textTertiary, fontStyle: 'italic' },
        link: { ...fonts.medium, color: colors.infoInk },
        codespan: {
            ...fonts.mono,
            fontSize: type.body.fontSize * 0.85,
            color: colors.errorInk,
            backgroundColor: tint(colors.error, 8),
        },
        blockquote: {
            borderLeftWidth: 3,
            borderLeftColor: colors.accentPrimary,
            paddingLeft: spacing[3],
            gap: spacing[1.5],
        },
        quoteText: { color: colors.textSecondary },
        hr: { borderTopWidth: StyleSheet.hairlineWidth * 2, borderTopColor: colors.borderDefault, marginVertical: spacing[1] },
        list: { gap: spacing[0.5] },
        item: { flexDirection: 'row' },
        marker: { ...type.body, color: colors.textSecondary, textAlign: 'right', paddingRight: spacing[1.5] },
        itemBody: { flex: 1, minWidth: 0, gap: spacing[1] },
        check: { paddingRight: spacing[1.5], paddingTop: 3 },
        image: { borderRadius: radii.sm, backgroundColor: colors.bgTertiary },
    });
}

export const markdownStyles = perTheme(build);

export type MarkdownStyles = ReturnType<typeof build>;
