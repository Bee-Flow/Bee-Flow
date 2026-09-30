/**
 * Shown once, during the first recording: some phones' battery managers stop
 * apps in the background anyway, and the fix is a setting only the person can
 * change. The button opens this app's own settings page (Linking.openSettings),
 * where Battery is one tap away; no permission is asked for.
 */

import React, { useEffect, useState } from 'react';
import { Linking, StyleSheet, View } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Banner, Button, Text } from '@/shared/ui';

import { claimBatteryHint } from '../model/batteryHint';

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        wrap: { paddingHorizontal: theme.spacing.lg, paddingTop: theme.spacing.md },
        body: { gap: theme.spacing.sm },
        actions: { flexDirection: 'row', gap: theme.spacing.sm },
    });

export function BatteryHint() {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const [visible, setVisible] = useState(false);

    useEffect(() => {
        let alive = true;
        void claimBatteryHint().then((first) => {
            if (alive && first) setVisible(true);
        });
        return () => {
            alive = false;
        };
    }, []);

    if (!visible) return null;
    return (
        <View style={styles.wrap}>
            <Banner tone="info">
                <View style={styles.body}>
                    <Text variant="caption" tone="secondary">
                        {t(
                            'mobile.recording.battery_hint',
                            'Some phones stop apps in the background to save battery. If a recording ever stops on its own, allow Bee Flow to run in the background in its battery settings.',
                        )}
                    </Text>
                    <View style={styles.actions}>
                        <Button
                            label={t('mobile.recording.battery_settings', 'Open app settings')}
                            variant="secondary"
                            size="sm"
                            onPress={() => void Linking.openSettings()}
                        />
                        <Button label={t('meetings.dismiss', 'Dismiss')} variant="ghost" size="sm" onPress={() => setVisible(false)} />
                    </View>
                </View>
            </Banner>
        </View>
    );
}
