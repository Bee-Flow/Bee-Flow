/**
 * The header's notification bell, with the unread badge.
 *
 * A header accessory: app/_layout.tsx hands it to HeaderAccessoryProvider, and
 * every ScreenHeader with `global` on renders it after search. It lives here
 * rather than in shared/ui because the count is an API call.
 */

import { useRouter } from 'expo-router';
import React from 'react';
import { StyleSheet, View } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useTheme } from '@/core/theme/ThemeProvider';
import { Icon, IconButton, Text } from '@/shared/ui';

import { useUnreadCount } from '../hooks/useUnreadCount';

export function NotificationBell() {
    const theme = useTheme();
    const t = useTranslation();
    const router = useRouter();
    const unread = useUnreadCount();
    return (
        <View>
            <IconButton
                icon={<Icon name="Bell" size={20} color={theme.colors.textSecondary} />}
                accessibilityLabel={
                    unread > 0
                        ? t('mobile.notifications.bell_unread', 'Notifications, {count} unread', { count: unread })
                        : t('notifications.title', 'Notifications')
                }
                onPress={() => router.push('/notifications')}
            />
            {unread > 0 ? (
                <View pointerEvents="none" style={[styles.badge, { backgroundColor: theme.colors.error }]}>
                    {/*
                      * No font-size override: `label` is already the scale's
                      * floor at 11px, and a hardcoded 10 would also opt the
                      * badge out of the user's text-size setting.
                      */}
                    <Text variant="label" style={styles.count} maxFontSizeMultiplier={1.3}>
                        {unread > 99 ? '99+' : String(unread)}
                    </Text>
                </View>
            ) : null}
        </View>
    );
}

const styles = StyleSheet.create({
    badge: {
        position: 'absolute',
        top: 6,
        right: 6,
        minWidth: 18,
        height: 18,
        paddingHorizontal: 4,
        borderRadius: 9,
        alignItems: 'center',
        justifyContent: 'center',
    },
    count: { color: '#fff' },
});
