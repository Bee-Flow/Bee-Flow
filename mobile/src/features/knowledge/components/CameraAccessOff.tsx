/**
 * What the scanner shows until camera access is granted. Once Android will no
 * longer ask (`blocked`), the button opens this app's page in Android's
 * settings instead of a request that would do nothing.
 */

import React from 'react';
import { View } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useTheme } from '@/core/theme/ThemeProvider';
import { Button, Icon, Text } from '@/shared/ui';

import { scanStyles as styles } from './scanStyles';

export function CameraAccessOff({ blocked, onAllow, onCancel }: { blocked: boolean; onAllow: () => void; onCancel: () => void }) {
    const theme = useTheme();
    const t = useTranslation();
    return (
        <View style={[styles.centre, { padding: theme.spacing.xxl, gap: theme.spacing.lg }]}>
            <Icon name="CameraOff" size={32} color="#fff" />
            <Text variant="heading" center style={styles.onDark}>
                {t('mobile.device.camera_off_title', 'Camera access is off')}
            </Text>
            <Text variant="body" center style={styles.onDarkMuted}>
                {blocked
                    ? t('mobile.device.camera_off_body', "Android will not ask again. Allow the camera in Bee Flow's settings, then come back here.")
                    : t(
                          'mobile.knowledge.scan_camera_body',
                          'Bee Flow needs the camera to scan a document into your library. Nothing is captured until you press the shutter.',
                      )}
            </Text>
            <Button
                label={blocked ? t('mobile.device.open_settings', 'Open Android settings') : t('mobile.knowledge.scan_allow_camera', 'Allow camera')}
                onPress={onAllow}
            />
            <Button label={t('mobile.knowledge.scan_not_now', 'Not now')} variant="ghost" onPress={onCancel} />
        </View>
    );
}
