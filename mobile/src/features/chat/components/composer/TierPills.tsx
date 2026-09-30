/**
 * The tiers that are kinds of work rather than depths — Flow, Swarm, Write and
 * custom tiers — as pills under the track, never as stops on it: putting Write
 * between Think and Deep Thinking would assert a ranking that does not exist.
 */

import React from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { useTheme, useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { tierLabel, type TierKey, type TierMap } from '@/features/chat/model/tiers';
import { Text } from '@/shared/ui';


const makeStyles = (theme: Theme) => ({
    row: {
        marginTop: 14,
        paddingTop: 12,
        borderTopWidth: StyleSheet.hairlineWidth,
        borderTopColor: theme.colors.borderSubtle,
        flexDirection: 'row' as const,
        flexWrap: 'wrap' as const,
        gap: 6,
    },
    pill: {
        paddingHorizontal: 10,
        paddingVertical: 5,
        borderRadius: theme.radii.pill,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.borderSubtle,
    },
});

export function TierPills({
    others,
    tiers,
    value,
    onChange,
}: {
    others: TierKey[];
    tiers: TierMap;
    value: TierKey;
    onChange: (next: TierKey) => void;
}) {
    const theme = useTheme();
    const styles = useThemedStyles(makeStyles);
    return (
        <View style={styles.row}>
            {others.map((key) => {
                const selected = key === value;
                return (
                    <Pressable
                        key={key}
                        onPress={() => onChange(key)}
                        accessibilityRole="button"
                        accessibilityState={{ selected }}
                        style={[
                            styles.pill,
                            { backgroundColor: selected ? theme.colors.accentFill : theme.colors.bgTertiary },
                        ]}
                    >
                        <Text
                            variant="caption"
                            weight="medium"
                            style={{ color: selected ? theme.colors.accentFillFg : theme.colors.textPrimary }}
                        >
                            {tierLabel(key, tiers[key])}
                        </Text>
                    </Pressable>
                );
            })}
        </View>
    );
}
