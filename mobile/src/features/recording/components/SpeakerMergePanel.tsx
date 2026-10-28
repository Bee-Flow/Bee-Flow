/**
 * Two or more speakers selected: pick who they really are. Tapping a name
 * saves the merge (and any renames) at once — the diarizer split one person
 * into several voices, and this is the repair.
 */

import React from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';

import { useTranslation } from '@/core/i18n';
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
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    if (selected.length < 2) return null;
    return (
        <View style={styles.panel}>
            <Text variant="caption" tone="secondary">
                {t('mobile.recording.merge_intro', 'Merge {count} speakers into one. Pick who they really are:', { count: selected.length })}
            </Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
                {selected.map((id) => (
                    <Chip key={id} label={names[id] ?? id} onPress={() => onMergeInto(id)} />
                ))}
            </ScrollView>
            <Text variant="caption" tone="tertiary">
                {t('mobile.recording.merge_warning', 'Merging cannot be undone from here — the turns are relabelled.')}
            </Text>
        </View>
    );
}
