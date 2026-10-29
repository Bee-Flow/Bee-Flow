/** The scanner's top bar: close, and how many pages are captured so far. */

import React from 'react';
import { View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useTranslation } from '@/core/i18n';
import { useTheme } from '@/core/theme/ThemeProvider';
import { Icon, IconButton, Text } from '@/shared/ui';

import { scanStyles as styles } from './scanStyles';

export function ScanTopBar({ count, onClose }: { count: number; onClose: () => void }) {
    const t = useTranslation();
    const theme = useTheme();
    const insets = useSafeAreaInsets();
    return (
        <View style={[styles.topBar, { paddingTop: insets.top + theme.spacing.sm }]}>
            <IconButton
                icon={<Icon name="X" size={22} color="#fff" />}
                accessibilityLabel={t('mobile.knowledge.scan_close', 'Close the scanner')}
                onPress={onClose}
            />
            <Text variant="caption" style={styles.topBarText} accessibilityLiveRegion="polite">
                {count === 0
                    ? t('mobile.knowledge.scan_frame', 'Fill the frame with the page')
                    : count === 1
                      ? t('mobile.knowledge.scan_captured_one', '1 page captured')
                      : t('mobile.knowledge.scan_captured_n', '{count} pages captured', { count })}
            </Text>
        </View>
    );
}
