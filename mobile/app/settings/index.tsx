/**
 * Settings — the hub.
 *
 * Deliberately shallow: eight rows, each one a screen. The web app's settings
 * page is a twenty-section accordion, which works with a mouse and a tall
 * window and is unusable with a thumb. Splitting it means every sub-screen
 * fits on one phone screen without a scroll, and the back button always means
 * "up one level".
 *
 * The status line under each row is not decoration — it is the answer to the
 * question people open Settings with ("is 2FA on?", "which server am I on?"),
 * so most visits end here without a tap.
 */

import { Feather } from '@expo/vector-icons';
import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import React from 'react';
import { ScrollView, View } from 'react-native';

import { getServerUrl } from '../../src/api/server';
import { useAuth } from '../../src/auth/AuthProvider';
import { getLicenseStatus, getMfaStatus, settingsKeys } from '../../src/features/settings/api';
import { humanise } from '../../src/features/settings/format';
import { useTheme } from '../../src/theme/ThemeProvider';
import { Group } from '../../src/ui/Group';
import { SettingRow } from '../../src/ui/List';
import { Screen } from '../../src/ui/Screen';
import { ScreenHeader } from '../../src/ui/ScreenHeader';
import { Text } from '../../src/ui/Text';

export default function SettingsScreen() {
    const theme = useTheme();
    const router = useRouter();
    const { user } = useAuth();

    // Both of these are cheap, cached, and answer a question the row labels
    // otherwise leave open. Neither is allowed to fail the screen: `retry:
    // false` plus a nullable read means a server that refuses one of them
    // still gives a working Settings page.
    const mfa = useQuery({
        queryKey: settingsKeys.mfa,
        queryFn: ({ signal }) => getMfaStatus(signal),
        retry: false,
        staleTime: 60_000,
    });
    const license = useQuery({
        queryKey: settingsKeys.license,
        queryFn: ({ signal }) => getLicenseStatus(signal),
        retry: false,
        staleTime: 5 * 60_000,
    });

    const serverHost = hostOf(getServerUrl());

    return (
        <Screen edges={['top']} inset>
            <ScreenHeader title="Settings" subtitle={user?.displayName} />

            <ScrollView
                contentContainerStyle={{
                    padding: theme.spacing.lg,
                    gap: theme.spacing.xl,
                    paddingBottom: theme.spacing.xxxl,
                }}
            >
                <Group title="This app">
                    <SettingRow
                        label="Appearance"
                        value={themeLabel(theme.preference)}
                        icon={<RowIcon name="droplet" />}
                        onPress={() => router.push('/settings/appearance')}
                    />
                    <SettingRow
                        label="Language"
                        icon={<RowIcon name="globe" />}
                        onPress={() => router.push('/settings/language')}
                    />
                    <SettingRow
                        label="Notifications"
                        icon={<RowIcon name="bell" />}
                        onPress={() => router.push('/settings/notifications')}
                    />
                    <SettingRow
                        label="Server"
                        value={serverHost}
                        icon={<RowIcon name="server" />}
                        onPress={() => router.push('/settings/server')}
                    />
                </Group>

                <Group title="Your account">
                    <SettingRow
                        label="Account"
                        value={user?.email ?? undefined}
                        icon={<RowIcon name="user" />}
                        onPress={() => router.push('/settings/account')}
                    />
                    <SettingRow
                        label="Security"
                        value={
                            mfa.data
                                ? mfa.data.enabled
                                    ? 'Two-factor on'
                                    : 'Two-factor off'
                                : undefined
                        }
                        icon={<RowIcon name="lock" />}
                        onPress={() => router.push('/settings/security')}
                    />
                    <SettingRow
                        label="Usage and spend"
                        value={license.data ? humanise(license.data.tier) : undefined}
                        icon={<RowIcon name="bar-chart-2" />}
                        onPress={() => router.push('/usage')}
                    />
                </Group>

                <Group title="Your organisation">
                    <SettingRow
                        label="Organisation"
                        value={user?.organizationId ?? undefined}
                        icon={<RowIcon name="briefcase" />}
                        onPress={() => router.push('/org')}
                    />
                    <SettingRow
                        label="Integrations"
                        icon={<RowIcon name="link" />}
                        onPress={() => router.push('/integrations')}
                    />
                    <SettingRow
                        label="Privacy and compliance"
                        icon={<RowIcon name="shield" />}
                        onPress={() => router.push('/org/privacy')}
                    />
                    <SettingRow
                        label="Administration"
                        icon={<RowIcon name="sliders" />}
                        onPress={() => router.push('/admin')}
                    />
                </Group>

                <Group title="Help">
                    <SettingRow
                        label="Help and support"
                        icon={<RowIcon name="life-buoy" />}
                        onPress={() => router.push('/support')}
                    />
                    <SettingRow
                        label="About Bee Flow"
                        icon={<RowIcon name="info" />}
                        onPress={() => router.push('/settings/about')}
                    />
                </Group>

                <Text variant="caption" tone="tertiary" center>
                    Every setting here applies to your account, not just this phone, unless the
                    screen says otherwise.
                </Text>
            </ScrollView>
        </Screen>
    );
}

function RowIcon({ name }: { name: keyof typeof Feather.glyphMap }) {
    const theme = useTheme();
    return (
        <View
            style={{
                width: 30,
                height: 30,
                borderRadius: theme.radii.sm,
                alignItems: 'center',
                justifyContent: 'center',
                backgroundColor: theme.colors.bgTertiary,
            }}
        >
            <Feather name={name} size={15} color={theme.colors.textSecondary} />
        </View>
    );
}

/** "beeflow.nl" from "https://beeflow.nl" — the host is the recognisable part. */
function hostOf(url: string | null): string | undefined {
    if (!url) return undefined;
    try {
        return new URL(url).host;
    } catch {
        return url;
    }
}

/** 'system' is not a palette; the other eight are, and humanise turns
 *  'glass-dark' into 'Glass dark'. */
function themeLabel(preference: string): string {
    return preference === 'system' ? 'Follow system' : humanise(preference);
}
