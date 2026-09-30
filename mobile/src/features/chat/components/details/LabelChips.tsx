/** The user's labels as chips; a tap applies or removes one on this chat. */

import React from 'react';
import { View } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useTheme, useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import type { ChatDetails } from '@/features/chat/hooks/useChatDetails';
import { toggleLabel } from '@/features/chat/model/labels';
import { Chip, Spinner, Text } from '@/shared/ui';

const makeStyles = (theme: Theme) => ({
    chips: { flexDirection: 'row' as const, flexWrap: 'wrap' as const, gap: theme.spacing.sm },
    dot: { width: 8, height: 8, borderRadius: 4 },
});

export function LabelChips({ details }: { details: ChatDetails }) {
    const t = useTranslation();
    const theme = useTheme();
    const styles = useThemedStyles(makeStyles);
    const { labelsQuery, appliedLabelIds, patch } = details;
    const labels = labelsQuery.data ?? [];
    if (labelsQuery.isLoading) return <Spinner />;
    if (labels.length === 0) {
        return (
            <Text variant="caption" tone="tertiary">
                {t('mobile.chat.details.no_labels', 'No labels yet. Create the first one below.')}
            </Text>
        );
    }
    return (
        <View style={styles.chips}>
            {labels.map((label) => (
                <Chip
                    key={label.id}
                    label={label.name}
                    selected={appliedLabelIds.includes(label.id)}
                    icon={<View style={[styles.dot, { backgroundColor: label.color || theme.colors.accentPrimary }]} />}
                    onPress={() => patch.mutate({ labels: toggleLabel(appliedLabelIds, label.id) })}
                />
            ))}
        </View>
    );
}
