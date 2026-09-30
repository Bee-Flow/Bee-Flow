/**
 * Connect mode's strip across the canvas's top, in the controls' place: what
 * the next tap does — start a line at a dot or a step, then pick where it
 * goes — and the way out.
 */

import React from 'react';
import { View, type ViewStyle } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Button, Text } from '@/shared/ui';

export function ConnectBanner({ picking, onDone }: { picking: boolean; onDone: () => void }) {
    const styles = useThemedStyles(makeStyles);
    const t = useTranslation();
    return (
        <View style={styles.banner} accessibilityLiveRegion="polite">
            <Text variant="caption" weight="medium" style={styles.bannerText} numberOfLines={2}>
                {picking
                    ? t('mobile.flow.canvas.pick_target', 'Now tap the step the line goes to')
                    : t('mobile.flow.canvas.pick_port', 'Tap a dot, or a step, to start a line')}
            </Text>
            <Button size="sm" variant="ghost" label={t('common.close', 'Close')} onPress={onDone} testID="canvas-connect-done" />
        </View>
    );
}

const makeStyles = (theme: Theme) => ({
    banner: {
        position: 'absolute', top: theme.spacing[2], left: theme.spacing[2], right: theme.spacing[2], flexDirection: 'row', alignItems: 'center', gap: theme.spacing[2],
        paddingLeft: theme.spacing[3], paddingRight: theme.spacing[1], paddingVertical: theme.spacing[1.5], borderRadius: theme.radii.md,
        backgroundColor: theme.colors.bgCard, borderWidth: 1, borderColor: theme.colors.accentPrimary, boxShadow: theme.shadows.md,
    } satisfies ViewStyle,
    bannerText: { flex: 1 } satisfies ViewStyle,
});
