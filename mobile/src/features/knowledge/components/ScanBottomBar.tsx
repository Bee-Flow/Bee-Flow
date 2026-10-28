/** The scanner's bottom bar: the shutter, and "Use n" once there is something to use. */

import React from 'react';
import { Pressable, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useTranslation } from '@/core/i18n';
import { useTheme } from '@/core/theme/ThemeProvider';
import { Button } from '@/shared/ui';

import { scanStyles as styles } from './scanStyles';

export function ScanBottomBar({
    count,
    busy,
    onShoot,
    onFinish,
}: {
    count: number;
    busy: boolean;
    onShoot: () => void;
    onFinish: () => void;
}) {
    const t = useTranslation();
    const theme = useTheme();
    const insets = useSafeAreaInsets();
    return (
        <View style={[styles.bottomBar, { paddingBottom: insets.bottom + theme.spacing.lg }]}>
            <View style={styles.side} />
            <Pressable
                onPress={onShoot}
                accessibilityRole="button"
                accessibilityLabel={t('mobile.knowledge.scan_capture', 'Capture this page')}
                accessibilityState={{ busy }}
                style={({ pressed }) => [styles.shutter, { opacity: pressed || busy ? 0.7 : 1 }]}
            >
                <View style={styles.shutterInner} />
            </Pressable>
            <View style={styles.sideEnd}>
                {count > 0 ? (
                    <Button
                        label={t('mobile.knowledge.scan_use', 'Use {count}', { count })}
                        onPress={onFinish}
                        accessibilityHint={t('mobile.knowledge.scan_use_hint', 'Adds the captured pages to the upload queue')}
                    />
                ) : null}
            </View>
        </View>
    );
}
