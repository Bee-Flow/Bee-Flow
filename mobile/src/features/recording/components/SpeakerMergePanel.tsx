/**
 * Two or more speakers selected: pick who they really are. Tapping a name
 * saves the merge (and any renames) at once — the diarizer split one person
 * into several voices, and this is the repair.
 */

import React from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';

import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Chip, Text } from '@/shared/ui';

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        panel: {
            gap: theme.spacing.sm,
            padding: theme.spacing.md,
            borderRadius: theme.radii.md,
            backgroundColor: theme.colors.bgTertiary,
        },
        chips: { gap: theme.spacing.sm },
    });

export function SpeakerMergePanel({
    selected,
    names,
    onMergeInto,
}: {
    selected: readonly string[];
    names: Readonly<Record<string, string>>;
    onMergeInto: (id: string) => void;
}) {
    const styles = useThemedStyles(makeStyles);
    if (selected.length < 2) return null;
    return (
        <View style={styles.panel}>
            <Text variant="caption" tone="secondary">
                Merge {selected.length} speakers into one. Pick who they really are:
            </Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
                {selected.map((id) => (
                    <Chip key={id} label={names[id] ?? id} onPress={() => onMergeInto(id)} />
                ))}
            </ScrollView>
            <Text variant="caption" tone="tertiary">
                Merging cannot be undone from here — the turns are relabelled.
            </Text>
        </View>
    );
}
