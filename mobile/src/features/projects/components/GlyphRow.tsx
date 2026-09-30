/**
 * A line in a Solution's lists that is a sentence, not a link — a check's
 * finding, an entity in a release note: a glyph, the sentence, and the
 * quieter lines under it. `dense` packs those lines closer, for a note.
 */

import React, { type ReactNode } from 'react';
import { View, type ViewStyle } from 'react-native';

import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Text } from '@/shared/ui';

export function GlyphRow({
    glyph,
    text,
    dense = false,
    testID,
    children,
}: {
    glyph: ReactNode;
    text: string;
    dense?: boolean;
    testID?: string;
    children?: ReactNode;
}) {
    const styles = useThemedStyles(makeStyles);
    return (
        <View style={styles.row} testID={testID}>
            {glyph}
            <View style={[styles.body, dense && styles.dense]}>
                <Text variant="body">{text}</Text>
                {children}
            </View>
        </View>
    );
}

const makeStyles = (theme: Theme) => ({
    row: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: theme.spacing[2.5],
        paddingHorizontal: theme.spacing.lg,
        paddingVertical: theme.spacing.md,
    } satisfies ViewStyle,
    body: { flex: 1, gap: theme.spacing.xs } satisfies ViewStyle,
    dense: { gap: theme.spacing.xxs } satisfies ViewStyle,
});
