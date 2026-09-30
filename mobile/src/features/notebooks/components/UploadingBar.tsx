/**
 * Pinned to the bottom while an upload runs, on either tab, so leaving the
 * sources half never hides that something is still on its way. Tapping it
 * goes back to the queue.
 */

import React from 'react';
import { StyleSheet, View } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Button } from '@/shared/ui';

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        bar: {
            position: 'absolute',
            left: 0,
            right: 0,
            bottom: 0,
            padding: theme.spacing.lg,
            borderTopWidth: StyleSheet.hairlineWidth,
            borderTopColor: theme.colors.borderSubtle,
            backgroundColor: theme.colors.bgSecondary,
        },
    });

export function UploadingBar({ onPress }: { onPress: () => void }) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    return (
        <View style={styles.bar} accessibilityLiveRegion="polite">
            <Button label={t('mobile.notebooks.uploading', 'Uploading…')} variant="secondary" fullWidth loading onPress={onPress} />
        </View>
    );
}
