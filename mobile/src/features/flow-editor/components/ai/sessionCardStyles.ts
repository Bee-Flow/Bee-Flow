/**
 * The look the builder session's two cards share (SummaryCard, PlanCard):
 * a bordered card over the top of the conversation, with a small heading.
 */

import type { ViewStyle } from 'react-native';

import type { Theme } from '@/core/theme/ThemeProvider';

export const makeSessionCardStyles = (theme: Theme) => ({
    card: {
        gap: theme.spacing.xs, marginHorizontal: theme.spacing.lg, marginBottom: theme.spacing.sm, padding: theme.spacing.md,
        borderRadius: theme.radii.md, borderWidth: 1, borderColor: theme.colors.borderSubtle, backgroundColor: theme.colors.bgCard,
    } satisfies ViewStyle,
    head: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing.xs } satisfies ViewStyle,
    todo: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm } satisfies ViewStyle,
    done: { color: theme.colors.success },
    open: { color: theme.colors.textTertiary },
});
