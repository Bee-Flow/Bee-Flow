/** Styles the meeting screen's cards and sections share. Use with useThemedStyles. */

import { StyleSheet } from 'react-native';

import type { Theme } from '@/core/theme/ThemeProvider';

export const makeMeetingStyles = (theme: Theme) =>
    StyleSheet.create({
        /** The processing and failed cards stand alone above an empty transcript. */
        statusFrame: { gap: theme.spacing.lg, paddingVertical: theme.spacing.lg },
        notesFrame: { gap: theme.spacing.xl, paddingVertical: theme.spacing.lg },
        stackSm: { gap: theme.spacing.sm },
        stackMd: { gap: theme.spacing.md },
        titleRow: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm },
        wrapRow: { flexDirection: 'row', gap: theme.spacing.sm, flexWrap: 'wrap' },
        line: { flexDirection: 'row', gap: theme.spacing.sm },
        lineIcon: { marginTop: 4 },
        lineText: { flex: 1 },
        speakerDot: { width: 8, height: 8, borderRadius: 4 },
        chapter: { flexDirection: 'row', gap: theme.spacing.md },
        chapterStart: { width: 64, fontVariant: ['tabular-nums'] },
        chapterBody: { flex: 1, gap: 2 },
        sheetList: { paddingBottom: theme.spacing.md },
        sheetFooter: { paddingBottom: theme.spacing.sm },
        askBody: { paddingHorizontal: theme.spacing.lg },
        transcript: { paddingHorizontal: theme.spacing.lg, paddingBottom: theme.spacing.xxxl },
    });
