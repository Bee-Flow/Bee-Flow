/** The scanner's bottom bar: the shutter, and "Use n" once there is something to use. */

import React from 'react';
import { Pressable, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

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
    const theme = useTheme();
    const insets = useSafeAreaInsets();
    return (
        <View style={[styles.bottomBar, { paddingBottom: insets.bottom + theme.spacing.lg }]}>
            <View style={styles.side} />
            <Pressable
                onPress={onShoot}
                accessibilityRole="button"
                accessibilityLabel="Capture this page"
                accessibilityState={{ busy }}
                style={({ pressed }) => [styles.shutter, { opacity: pressed || busy ? 0.7 : 1 }]}
            >
                <View style={styles.shutterInner} />
            </Pressable>
            <View style={styles.sideEnd}>
                {count > 0 ? (
                    <Button
                        label={`Use ${count}`}
                        onPress={onFinish}
                        accessibilityHint="Adds the captured pages to the upload queue"
                    />
                ) : null}
            </View>
        </View>
    );
}
