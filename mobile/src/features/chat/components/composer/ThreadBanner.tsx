/**
 * "Replying to …" above the composer (the web's thread banner in InputArea):
 * this send goes into a thread, not the main conversation, and the way out
 * is one tap.
 */

import React from 'react';
import { View } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useTheme, useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Icon, IconButton, Text } from '@/shared/ui';

const makeStyles = (theme: Theme) => ({
    banner: {
        flexDirection: 'row' as const,
        alignItems: 'center' as const,
        gap: theme.spacing.sm,
        paddingLeft: theme.spacing.md,
        borderRadius: theme.radii.lg,
        backgroundColor: theme.colors.bgSecondary,
    },
    words: { flex: 1 },
});

export function ThreadBanner({ title, onExit }: { title: string | null; onExit: () => void }) {
    const t = useTranslation();
    const theme = useTheme();
    const styles = useThemedStyles(makeStyles);
    return (
        <View style={styles.banner}>
            <Icon name="CornerDownRight" size={14} color={theme.colors.textTertiary} />
            <Text variant="caption" tone="secondary" style={styles.words} numberOfLines={1}>
                {`${t('chat.composer.replying_to', 'Replying to')} `}
                <Text variant="caption" weight="medium">
                    {title || t('chat.composer.thread_fallback', 'Thread')}
                </Text>
            </Text>
            <IconButton
                icon={<Icon name="X" size={16} color={theme.colors.textSecondary} />}
                accessibilityLabel={t('chat.composer.exit_thread', 'Leave this thread')}
                onPress={onExit}
            />
        </View>
    );
}
