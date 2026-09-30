/**
 * The report's select mode, in place of the filters: how many notes are
 * picked (of the server's ten), Ask AI, and the way out.
 */

import React from 'react';
import { StyleSheet, View } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useTheme } from '@/core/theme/ThemeProvider';
import { Button, Icon, IconButton, Text } from '@/shared/ui';

import { REPORT_MAX_NOTES } from '../model/library';

const styles = StyleSheet.create({
    bar: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    count: { flex: 1 },
});

export function SelectionBar({
    count,
    onAsk,
    onCancel,
}: {
    count: number;
    onAsk: () => void;
    onCancel: () => void;
}) {
    const t = useTranslation();
    const theme = useTheme();
    return (
        <View style={styles.bar}>
            <Text variant="caption" tone="tertiary" style={styles.count}>
                {t('meetings.report_selected', '{selected}/{max} selected — click meetings to select', {
                    selected: count,
                    max: REPORT_MAX_NOTES,
                })}
            </Text>
            <Button
                label={t('meetings.ask_ai', 'Ask AI')}
                iconName="Sparkles"
                size="sm"
                disabled={count === 0}
                onPress={onAsk}
            />
            <IconButton
                icon={<Icon name="X" size={18} color={theme.colors.textTertiary} />}
                accessibilityLabel={t('meetings.cancel_selection', 'Cancel selection')}
                onPress={onCancel}
            />
        </View>
    );
}
