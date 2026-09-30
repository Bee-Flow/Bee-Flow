/**
 * The way back to the newest message, floating over the transcript while it
 * is scrolled away from it — the round ↓ the web's chat shows in the same
 * place. Without it, a long chat read from the top has to be flung back down
 * by hand.
 */

import React from 'react';
import { StyleSheet, View } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useTheme, useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Icon, IconButton } from '@/shared/ui';

const makeStyles = (theme: Theme) => ({
    bar: {
        position: 'absolute' as const,
        left: 0,
        right: 0,
        bottom: theme.spacing.md,
        alignItems: 'center' as const,
    },
    // The disc carries the fill and the edge; the button inside keeps its own
    // pressed tint, clipped to the circle.
    disc: {
        borderRadius: theme.radii.pill,
        overflow: 'hidden' as const,
        backgroundColor: theme.colors.bgCard,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.cardBorder,
        boxShadow: theme.shadows.md,
    },
});

export function JumpToLatest({ onPress }: { onPress: () => void }) {
    const t = useTranslation();
    const theme = useTheme();
    const styles = useThemedStyles(makeStyles);
    return (
        <View style={styles.bar} pointerEvents="box-none">
            <View style={styles.disc}>
                <IconButton
                    icon={<Icon name="ArrowDown" size={20} color={theme.colors.textPrimary} />}
                    accessibilityLabel={t('mobile.chat.jump_latest', 'Jump to the latest message')}
                    onPress={onPress}
                />
            </View>
        </View>
    );
}
