/** A chart's legend under the plot (the web's mobile `orient: bottom`): a swatch and a name per series. */

import React from 'react';
import { StyleSheet, View, type ViewStyle } from 'react-native';

import { Text } from '@/shared/ui';

import type { LegendItem } from './chartModel';

const styles = StyleSheet.create({
    legend: { flexDirection: 'row', flexWrap: 'wrap', columnGap: 12, rowGap: 4, paddingHorizontal: 12 },
    item: { flexDirection: 'row', alignItems: 'center', gap: 5 },
    swatch: { width: 9, height: 9, borderRadius: 5 },
});

function fill(color: string): ViewStyle {
    return { backgroundColor: color };
}

export function ChartLegend({ items }: { items: LegendItem[] }) {
    if (!items.length) return null;
    return (
        <View style={styles.legend}>
            {items.map((item) => (
                <View key={item.label} style={styles.item}>
                    <View style={[styles.swatch, fill(item.color)]} />
                    <Text variant="label" tone="secondary">
                        {item.label}
                    </Text>
                </View>
            ))}
        </View>
    );
}
