/** The column, bordered card and nested-group rail the contract editors (list fields, rules) share. */

import type { ViewStyle } from 'react-native';

import type { Theme } from '@/core/theme/ThemeProvider';

export const makeEditorStyles = (theme: Theme) => ({
    block: { gap: theme.spacing[2] } satisfies ViewStyle,
    card: {
        gap: theme.spacing[2],
        padding: theme.spacing[3],
        borderRadius: theme.radii.md,
        borderWidth: 1,
        borderColor: theme.colors.borderSubtle,
    } satisfies ViewStyle,
    /** A group inside a group: the web's `border-l-2 pl-2`. */
    rail: {
        gap: theme.spacing[2],
        paddingLeft: theme.spacing[2],
        borderLeftWidth: 2,
        borderLeftColor: theme.colors.borderSubtle,
    } satisfies ViewStyle,
    actions: { flexDirection: 'row', flexWrap: 'wrap', gap: theme.spacing[2] } satisfies ViewStyle,
});
