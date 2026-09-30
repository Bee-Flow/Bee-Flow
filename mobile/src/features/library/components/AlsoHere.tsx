/**
 * Memory and house styles, as rows rather than sections. Both are things you
 * check occasionally and change rarely, and neither has enough items to be
 * worth a screen of its own on a phone.
 */

import React from 'react';
import { StyleSheet, View } from 'react-native';

import { useTheme, useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Divider, Icon, ListRow, Text } from '@/shared/ui';

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        block: { gap: theme.spacing.sm },
        label: { paddingHorizontal: theme.spacing.lg },
        card: {
            marginHorizontal: theme.spacing.lg,
            borderRadius: theme.radii.lg,
            backgroundColor: theme.colors.bgCard,
            overflow: 'hidden',
        },
    });

export function AlsoHere({ onMemory, onHouseStyles }: { onMemory: () => void; onHouseStyles: () => void }) {
    const theme = useTheme();
    const styles = useThemedStyles(makeStyles);
    return (
        <View style={styles.block}>
            <Text variant="label" tone="tertiary" style={styles.label}>
                ALSO HERE
            </Text>
            <View style={styles.card}>
                <ListRow
                    title="Memory"
                    subtitle="What Bee Flow carries between conversations"
                    leading={<Icon name="Cpu" size={18} color={theme.colors.textMuted} />}
                    onPress={onMemory}
                />
                <Divider inset={theme.spacing.lg} />
                <ListRow
                    title="House styles"
                    subtitle="The Word styling applied to notebook exports"
                    leading={<Icon name="Type" size={18} color={theme.colors.textMuted} />}
                    onPress={onHouseStyles}
                />
            </View>
        </View>
    );
}
