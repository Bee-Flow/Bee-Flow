/** A facet's heading — "Steps · in this order", "Rules · always, whatever the question" — with its add button. */

import React from 'react';
import { StyleSheet, View } from 'react-native';

import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Button, Text } from '@/shared/ui';

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        titles: { flex: 1, gap: 2 },
        head: { gap: theme.spacing.sm, flexDirection: 'row', alignItems: 'center' },
    });

export function FacetHead({
    title,
    hint,
    empty,
    addLabel,
    onAdd,
    testID,
}: {
    title: string;
    hint: string;
    /** Shown under the heading while the facet has nothing in it. */
    empty?: string | null;
    addLabel?: string;
    onAdd?: () => void;
    testID?: string;
}) {
    const styles = useThemedStyles(makeStyles);
    return (
        <>
            <View style={styles.head}>
                <View style={styles.titles}>
                    <Text variant="heading">{title}</Text>
                    <Text variant="caption" tone="tertiary">
                        {hint}
                    </Text>
                </View>
                {onAdd && addLabel ? <Button size="sm" variant="secondary" iconName="Plus" label={addLabel} onPress={onAdd} testID={testID} /> : null}
            </View>
            {empty ? (
                <Text variant="caption" tone="tertiary">
                    {empty}
                </Text>
            ) : null}
        </>
    );
}
