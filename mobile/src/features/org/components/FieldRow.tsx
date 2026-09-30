/** A form control inside a Group card, inset like the kit's rows. */

import React, { type ReactNode } from 'react';
import { View } from 'react-native';

import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';

const makeStyles = (theme: Theme) => ({
    row: { paddingHorizontal: theme.spacing.lg, paddingVertical: theme.spacing.md, gap: theme.spacing.sm },
});

export function FieldRow({ children }: { children: ReactNode }) {
    const styles = useThemedStyles(makeStyles);
    return <View style={styles.row}>{children}</View>;
}
