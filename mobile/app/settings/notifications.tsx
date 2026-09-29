/**
 * Notification settings.
 *
 * The headline fact this screen has to land: Bee Flow does NOT use Google's
 * push service. There is no Firebase sender id in app.config.ts, no FCM token
 * leaves the device, and nothing about your work passes through a third party
 * to reach your phone. Instead the app polls its own server and raises the
 * notification locally.
 *
 * That is a selling point, not an apology, so it is stated first and plainly —
 * and the cost (a message can be up to one polling interval late) is stated
 * just as plainly, with the interval as a control rather than a secret.
 *
 * The preferences live on the device (src/features/notifications/prefs.ts),
 * because the server has no notification-preference table — `notifications` is
 * a log with a `category` column and nothing that records who wants what. The
 * screen says which settings are per-device so nobody expects them on the web.
 */

import { Feather } from '@expo/vector-icons';
import * as Notifications from 'expo-notifications';
import { useRouter } from 'expo-router';
import React, { useCallback, useEffect, useState } from 'react';
import { Linking, ScrollView, View } from 'react-native';

import {
    CATEGORY_LABELS,
    DEFAULT_NOTIFICATION_PREFS,
    loadNotificationPrefs,
    NOTIFICATION_CATEGORIES,
    POLL_INTERVALS,
    saveNotificationPrefs,
    type NotificationPrefs,
} from '../../src/features/notifications/prefs';
import { useTheme } from '../../src/theme/ThemeProvider';
import { Button } from '../../src/ui/Button';
import { OptionRow, ToggleRow } from '../../src/ui/Controls';
import { Banner, LoadingState } from '../../src/ui/Feedback';
import { Group, NoteRow } from '../../src/ui/Group';
import { SettingRow } from '../../src/ui/List';
import { Screen } from '../../src/ui/Screen';
import { ScreenHeader } from '../../src/ui/ScreenHeader';
import { Text } from '../../src/ui/Text';

export default function NotificationSettingsScreen() {
    const theme = useTheme();
    const router = useRouter();

    const [prefs, setPrefs] = useState<NotificationPrefs | null>(null);
    const [osPermission, setOsPermission] = useState<Notifications.PermissionStatus | null>(null);

    useEffect(() => {
        void loadNotificationPrefs().then(setPrefs);
        void Notifications.getPermissionsAsync().then((result) => setOsPermission(result.status));
    }, []);

    /** Optimistic: the switch moves now and the write follows. A failed write
     *  to AsyncStorage is not worth a spinner on a toggle. */
    const update = useCallback((patch: Partial<NotificationPrefs>) => {
        setPrefs((previous) => {
            const next = { ...(previous ?? DEFAULT_NOTIFICATION_PREFS), ...patch };
            void saveNotificationPrefs(next);
            return next;
        });
    }, []);

    const setCategory = (category: (typeof NOTIFICATION_CATEGORIES)[number], value: boolean) => {
        setPrefs((previous) => {
            const base = previous ?? DEFAULT_NOTIFICATION_PREFS;
            const next = { ...base, categories: { ...base.categories, [category]: value } };
            void saveNotificationPrefs(next);
            return next;
        });
    };

    const requestPermission = async () => {
        const result = await Notifications.requestPermissionsAsync();
        setOsPermission(result.status);
        // Android only shows its prompt once. After a denial the only route is
        // the system settings page, so send them there rather than letting a
        // button do nothing on the second tap.
        if (result.status === 'denied') void Linking.openSettings();
    };

    if (!prefs) {
        return (
            <Screen edges={['top']} inset>
                <ScreenHeader title="Notifications" />
                <LoadingState />
            </Screen>
        );
    }

    const osBlocked = osPermission !== null && osPermission !== 'granted';

    return (
        <Screen edges={['top']} inset>
            <ScreenHeader title="Notifications" subtitle="On this phone" />

            <ScrollView
                contentContainerStyle={{
                    padding: theme.spacing.lg,
                    gap: theme.spacing.xl,
                    paddingBottom: theme.spacing.xxxl,
                }}
            >
                <Banner tone="success" icon="shield">
                    <View style={{ gap: theme.spacing.xs }}>
                        <Text variant="caption" weight="semibold">
                            No Google push. Ever.
                        </Text>
                        <Text variant="caption" tone="tertiary">
                            Bee Flow asks your own server what is new and raises the notification on
                            this device. Nothing about your work — not a title, not a sender, not
                            the fact that a message exists — passes through Firebase or any other
                            third party. The trade is that a notification can be up to one polling
                            interval late, and you choose that interval below.
                        </Text>
                    </View>
                </Banner>

                {osBlocked ? (
                    <Group title="Android permission">
                        <NoteRow>
                            <View style={{ gap: theme.spacing.sm }}>
                                <Text variant="body">Android is blocking notifications</Text>
                                <Text variant="caption" tone="tertiary">
                                    Bee Flow can still show you what is new inside the app, but it
                                    cannot notify you while you are elsewhere.
                                </Text>
                                <Button
                                    label={
                                        osPermission === 'denied'
                                            ? 'Open Android settings'
                                            : 'Allow notifications'
                                    }
                                    variant="secondary"
                                    onPress={() => void requestPermission()}
                                />
                            </View>
                        </NoteRow>
                    </Group>
                ) : null}

                <Group
                    title="Notify me"
                    footer="These choices are stored on this phone. Another device signed in to the same account keeps its own."
                >
                    <ToggleRow
                        label="Show notifications"
                        description="Turn everything off without touching Android's settings"
                        value={prefs.enabled}
                        onValueChange={(value) => update({ enabled: value })}
                        icon={<Feather name="bell" size={16} color={theme.colors.textSecondary} />}
                    />
                    <ToggleRow
                        label="Play a sound"
                        description="Off still shows the notification, silently"
                        value={prefs.sound}
                        disabled={!prefs.enabled}
                        onValueChange={(value) => update({ sound: value })}
                        icon={
                            <Feather name="volume-2" size={16} color={theme.colors.textSecondary} />
                        }
                    />
                </Group>

                <Group
                    title="What to tell me about"
                    footer="These are the server's own six categories — the same ones the notification list uses."
                >
                    {NOTIFICATION_CATEGORIES.map((category) => (
                        <ToggleRow
                            key={category}
                            label={CATEGORY_LABELS[category].label}
                            description={CATEGORY_LABELS[category].description}
                            value={prefs.categories[category]}
                            disabled={!prefs.enabled}
                            onValueChange={(value) => setCategory(category, value)}
                        />
                    ))}
                </Group>

                <Group
                    title="How often to check"
                    footer="Bee Flow only polls while the app is running or the background task is allowed to wake it. Android decides how generous that is, so a longer interval genuinely costs less battery."
                >
                    {POLL_INTERVALS.map((interval) => (
                        <OptionRow
                            key={interval.seconds}
                            label={interval.label}
                            description={interval.hint}
                            selected={prefs.pollSeconds === interval.seconds}
                            disabled={!prefs.enabled}
                            onPress={() => update({ pollSeconds: interval.seconds })}
                        />
                    ))}
                </Group>

                <Group title="See what is waiting">
                    <SettingRow
                        label="Open notifications"
                        icon={<Feather name="inbox" size={16} color={theme.colors.textSecondary} />}
                        onPress={() => router.push('/notifications')}
                    />
                </Group>
            </ScrollView>
        </Screen>
    );
}
