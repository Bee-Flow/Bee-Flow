/**
 * Send and Stop are the SAME button in the same place. A separate stop control
 * means hunting for it while tokens stream past.
 */

import React from 'react';
import { Pressable } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useTheme, useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Icon } from '@/shared/ui';

const makeStyles = (theme: Theme) => ({
    button: {
        width: 40,
        height: 40,
        borderRadius: theme.radii.pill,
        alignItems: 'center' as const,
        justifyContent: 'center' as const,
    },
});

export function SendButton({ streaming, canSend, onPress }: { streaming: boolean; canSend: boolean; onPress: () => void }) {
    const t = useTranslation();
    const theme = useTheme();
    const styles = useThemedStyles(makeStyles);
    const live = !streaming && canSend;
    return (
        <Pressable
            onPress={onPress}
            disabled={!streaming && !canSend}
            accessibilityRole="button"
            accessibilityLabel={
                streaming ? t('chat.composer.stop_generating', 'Stop generating') : t('chat.composer.send_label', 'Send message')
            }
            style={[styles.button, { backgroundColor: live ? theme.colors.accentFill : theme.colors.bgTertiary }]}
        >
            <Icon
                name={streaming ? 'Square' : 'ArrowUp'}
                size={20}
                color={streaming ? theme.colors.textPrimary : live ? theme.colors.accentFillFg : theme.colors.textMuted}
            />
        </Pressable>
    );
}
