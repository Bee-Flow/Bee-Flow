/** Pin: one switch, sent as the conversation PATCH's `pinned` alone. */

import React from 'react';
import { View } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useTheme, useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import type { ChatDetails } from '@/features/chat/hooks/useChatDetails';
import { Card, Icon, Switch, Text } from '@/shared/ui';


const makeStyles = (theme: Theme) => ({
    row: {
        flexDirection: 'row' as const,
        alignItems: 'center' as const,
        gap: theme.spacing.md,
        padding: theme.spacing.lg,
        minHeight: theme.minTouch,
    },
    text: { flex: 1 },
});

export function PinCard({ details }: { details: ChatDetails }) {
    const t = useTranslation();
    const theme = useTheme();
    const styles = useThemedStyles(makeStyles);
    const { conversation, patch } = details;
    return (
        <Card padded={false}>
            <View style={styles.row}>
                <Icon name="Bookmark" size={18} color={theme.colors.textSecondary} />
                <View style={styles.text}>
                    <Text variant="body">{t('sidebar.pinned', 'Pinned')}</Text>
                    <Text variant="caption" tone="tertiary">
                        {t('mobile.chat.details.pin_hint', 'Keeps this chat at the top of the list.')}
                    </Text>
                </View>
                <Switch
                    value={Boolean(conversation?.pinned)}
                    onValueChange={(next) => patch.mutate({ pinned: next })}
                    disabled={patch.isPending}
                    accessibilityLabel={t('mobile.chat.details.pin_label', 'Pin this conversation')}
                />
            </View>
        </Card>
    );
}
