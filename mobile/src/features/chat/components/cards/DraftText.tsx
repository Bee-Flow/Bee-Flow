/** A draft's long text — an e-mail body, a post — in a bounded, scrollable box. */

import React from 'react';
import { ScrollView } from 'react-native';

import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Text } from '@/shared/ui';

const makeStyles = (theme: Theme) => ({
    box: {
        maxHeight: 320,
        borderRadius: theme.radii.md,
        borderWidth: 1,
        borderColor: theme.colors.borderSubtle,
        backgroundColor: theme.colors.bgPrimary,
    },
    content: { padding: theme.spacing.md },
});

export function DraftText({ value }: { value: string }) {
    const styles = useThemedStyles(makeStyles);
    if (!value) return null;
    return (
        <ScrollView style={styles.box} contentContainerStyle={styles.content} nestedScrollEnabled>
            <Text variant="body" tone="secondary" selectable>
                {value}
            </Text>
        </ScrollView>
    );
}
