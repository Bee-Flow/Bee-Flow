/** Android is blocking notifications: say what still works, and offer the fix. */

import React from 'react';
import { StyleSheet, View } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Button, Group, NoteRow, Text } from '@/shared/ui';

export function OsPermissionGroup({
    denied,
    onRequest,
}: {
    /** Refused for good (Android will not ask again): only the system settings page can change it now. */
    denied: boolean;
    onRequest: () => void;
}) {
    const styles = useThemedStyles(makeStyles);
    const t = useTranslation();
    return (
        <Group title={t('mobile.notifications.android_permission', 'Android permission')}>
            <NoteRow>
                <View style={styles.note}>
                    <Text variant="body">{t('mobile.notifications.blocked', 'Android is blocking notifications')}</Text>
                    <Text variant="caption" tone="tertiary">
                        {t('mobile.notifications.blocked_hint', 'Bee Flow can still show you what is new inside the app, but it cannot notify you while you are elsewhere.')}
                    </Text>
                    <Button
                        label={denied ? t('mobile.notifications.open_android', 'Open Android settings') : t('mobile.notifications.allow', 'Allow notifications')}
                        variant="secondary"
                        onPress={onRequest}
                    />
                </View>
            </NoteRow>
        </Group>
    );
}

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        note: { gap: theme.spacing.sm },
    });
