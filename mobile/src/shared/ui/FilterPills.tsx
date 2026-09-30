/**
 * A row of pills that behaves as ONE single-choice filter — the web's
 * FilterPills ("All 15 · Failing 1 · Passing 9"). `value` is the active
 * option; a pill press reports its value. Each pill is a Chip, so the tones
 * and counts are the Chip's.
 *
 * Wraps by default, like the web's toolbar; pass `scroll` for a single line
 * that scrolls sideways (a filter strip under a header).
 */

import React from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';

import { Chip, type ChipTone } from './Chip';

export interface FilterPillOption<T extends string> {
    value: T;
    label: string;
    count?: number | null;
    tone?: ChipTone;
    disabled?: boolean;
}

export function FilterPills<T extends string>({
    value,
    onChange,
    options,
    accessibilityLabel,
    scroll = false,
    testID,
}: {
    value: T;
    onChange: (next: T) => void;
    options: readonly FilterPillOption<T>[];
    accessibilityLabel?: string;
    scroll?: boolean;
    testID?: string;
}) {
    const pills = options.map((option) => (
        <Chip
            key={option.value}
            testID={testID ? `${testID}-${option.value}` : undefined}
            label={option.label}
            count={option.count}
            tone={option.tone}
            disabled={option.disabled}
            selected={option.value === value}
            onPress={() => onChange(option.value)}
        />
    ));
    if (scroll) {
        return (
            <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                accessibilityLabel={accessibilityLabel}
                contentContainerStyle={styles.line}
                testID={testID}
            >
                {pills}
            </ScrollView>
        );
    }
    return (
        <View accessibilityLabel={accessibilityLabel} style={styles.wrap} testID={testID}>
            {pills}
        </View>
    );
}

const styles = StyleSheet.create({
    wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
    line: { flexDirection: 'row', gap: 6, paddingVertical: 2 },
});
