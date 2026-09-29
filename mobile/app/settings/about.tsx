/**
 * About.
 *
 * The job of this screen is to make a bug report precise. A person writing
 * "the app crashed" is not helpful; a person writing "1.0.0 (build 42),
 * production, sha 9f3a1c, server 8b21de" is. So the version block is
 * selectable, copyable in one tap, and names both halves — the APK and the
 * server it is talking to, which are versioned independently and are very
 * often the actual mismatch.
 *
 * Everything here comes from `Constants.expoConfig.extra` (populated by
 * app.config.ts from BEEFLOW_BUILD_PROFILE / BEEFLOW_COMMIT_SHA at build time)
 * and from `/api/health`, which reports the server's APP_BUILD_SHA.
 */

import { Feather } from '@expo/vector-icons';
import { useQuery } from '@tanstack/react-query';
import * as Application from 'expo-application';
import * as Clipboard from 'expo-clipboard';
import Constants from 'expo-constants';
import * as WebBrowser from 'expo-web-browser';
import React from 'react';
import { ScrollView, View } from 'react-native';

import { checkHealth, checkServerSupport, getServerUrl, MIN_SERVER_BUILD } from '../../src/api/server';
import { listReleaseNotes, settingsKeys } from '../../src/features/settings/api';
import { absoluteDate } from '../../src/features/settings/format';
import { useTheme } from '../../src/theme/ThemeProvider';
import { Badge } from '../../src/ui/Badge';
import { Button } from '../../src/ui/Button';
import { ListSkeleton } from '../../src/ui/Feedback';
import { Group, InfoRow, NoteRow } from '../../src/ui/Group';
import { SettingRow } from '../../src/ui/List';
import { Screen } from '../../src/ui/Screen';
import { ScreenHeader } from '../../src/ui/ScreenHeader';
import { Card } from '../../src/ui/Surface';
import { Text } from '../../src/ui/Text';
import { useToast } from '../../src/ui/Toast';

const DOCS_URL = 'https://docs.beeflow.ai/';
const REPO_URL = 'https://github.com/Bee-Flow/Bee-Flow';
const LICENSE_URL = 'https://github.com/Bee-Flow/Bee-Flow/blob/main/LICENSE.md';

interface BuildExtra {
    buildProfile?: string;
    commitSha?: string;
    defaultServerUrl?: string;
}

export default function AboutScreen() {
    const theme = useTheme();
    const { toast } = useToast();

    const extra = (Constants.expoConfig?.extra ?? {}) as BuildExtra;
    const version = Constants.expoConfig?.version ?? Application.nativeApplicationVersion ?? '—';
    const build = Application.nativeBuildVersion ?? '—';
    const sha = extra.commitSha ? extra.commitSha.slice(0, 7) : 'not stamped';
    const profile = extra.buildProfile ?? 'development';
    const server = getServerUrl();

    const health = useQuery({
        queryKey: settingsKeys.health,
        queryFn: () => (server ? checkHealth(server) : Promise.resolve(null)),
        staleTime: 60_000,
        retry: false,
    });

    // Capability probe, not a version compare — the server has no orderable
    // version number. Soft on purpose: an old server gets a warning here, not
    // a locked app. See MIN_SERVER_BUILD in src/api/contract.ts.
    const support = useQuery({
        queryKey: settingsKeys.serverSupport,
        queryFn: () => (server ? checkServerSupport(server) : Promise.resolve(null)),
        staleTime: 60_000,
        retry: false,
    });
    const supportLabel =
        support.data?.level === 'ok'
            ? `Compatible (needs ${MIN_SERVER_BUILD} or later)`
            : support.data?.level === 'outdated'
              ? `Older than ${MIN_SERVER_BUILD}`
              : 'Not determined';

    const notes = useQuery({
        queryKey: settingsKeys.releaseNotes,
        queryFn: ({ signal }) => listReleaseNotes(signal),
        staleTime: 30 * 60_000,
        retry: false,
    });

    /** One block, formatted for pasting into a support thread. */
    const copyDiagnostics = () => {
        const lines = [
            `Bee Flow for Android ${version} (build ${build})`,
            `profile: ${profile}`,
            `app sha: ${extra.commitSha || 'not stamped'}`,
            `server: ${server ?? 'not configured'}`,
            `server sha: ${health.data?.appVersion || 'not reported'}`,
            `server compatibility: ${supportLabel} (app needs a server built ${MIN_SERVER_BUILD} or later)`,
            `android: ${Application.applicationId ?? 'nl.beeflow.app'}`,
        ];
        void Clipboard.setStringAsync(lines.join('\n'));
        toast('Version details copied', 'success');
    };

    return (
        <Screen edges={['top']} inset>
            <ScreenHeader title="About" subtitle="Bee Flow for Android" />

            <ScrollView
                contentContainerStyle={{
                    padding: theme.spacing.lg,
                    gap: theme.spacing.xl,
                    paddingBottom: theme.spacing.xxxl,
                }}
            >
                <Card>
                    <View style={{ alignItems: 'center', gap: theme.spacing.sm }}>
                        <View
                            style={{
                                width: 56,
                                height: 56,
                                borderRadius: theme.radii.lg,
                                alignItems: 'center',
                                justifyContent: 'center',
                                backgroundColor: theme.colors.accentPrimary,
                            }}
                        >
                            <Feather
                                name="hexagon"
                                size={26}
                                color={theme.colors.accentPrimaryFg}
                            />
                        </View>
                        <Text variant="heading" center>
                            Bee Flow
                        </Text>
                        <Text variant="caption" tone="tertiary" center>
                            A self-hosted, zero-knowledge AI workspace. Your data stays on your
                            server; nobody at Bee Flow can read it.
                        </Text>
                        {profile !== 'production' ? (
                            <Badge label={profile.toUpperCase()} tone="warning" />
                        ) : null}
                    </View>
                </Card>

                <Group
                    title="This build"
                    footer="Quote both shas when you report a problem — the app and the server ship independently, and a mismatch between them is a common cause."
                >
                    <InfoRow label="App version" value={`${version} (${build})`} selectable />
                    <InfoRow label="Build profile" value={profile} />
                    <InfoRow label="App commit" value={sha} selectable />
                    <InfoRow
                        label="Server commit"
                        value={health.data?.appVersion || 'Not reported'}
                        selectable
                    />
                    <InfoRow label="Server" value={server ?? 'Not configured'} selectable />
                    <InfoRow label="Server compatibility" value={supportLabel} />
                    {support.data?.level === 'outdated' ? (
                        <NoteRow>
                            This server looks older than this app expects (a build from{' '}
                            {MIN_SERVER_BUILD} or later). Screens may misbehave in odd ways —
                            update the server before reporting a bug in the app.
                        </NoteRow>
                    ) : null}
                    <View style={{ padding: theme.spacing.lg }}>
                        <Button
                            label="Copy version details"
                            variant="secondary"
                            onPress={copyDiagnostics}
                            icon={
                                <Feather name="copy" size={16} color={theme.colors.textPrimary} />
                            }
                            fullWidth
                        />
                    </View>
                </Group>

                <Group title="What changed">
                    {notes.isLoading ? (
                        <NoteRow>
                            <ListSkeleton rows={2} />
                        </NoteRow>
                    ) : notes.data && notes.data.length > 0 ? (
                        notes.data.slice(0, 5).map((entry) => (
                            <View
                                key={entry.id}
                                style={{ padding: theme.spacing.lg, gap: theme.spacing.xs }}
                            >
                                <View
                                    style={{
                                        flexDirection: 'row',
                                        alignItems: 'center',
                                        gap: theme.spacing.sm,
                                    }}
                                >
                                    <Text variant="subheading" style={{ flex: 1 }}>
                                        {entry.title}
                                    </Text>
                                    {entry.version ? <Badge label={entry.version} /> : null}
                                </View>
                                <Text variant="label" tone="tertiary">
                                    {absoluteDate(entry.publishedAt)}
                                </Text>
                                {entry.lead ? (
                                    <Text variant="caption" tone="secondary">
                                        {entry.lead}
                                    </Text>
                                ) : null}
                                {entry.items?.slice(0, 4).map((item, index) => (
                                    <Text key={index} variant="caption" tone="tertiary">
                                        {'•'}  {item}
                                    </Text>
                                ))}
                            </View>
                        ))
                    ) : (
                        <NoteRow>
                            Your server has not published any release notes, or its changelog is
                            not reachable right now.
                        </NoteRow>
                    )}
                </Group>

                <Group
                    title="Licence and source"
                    footer="Bee Flow is fair-code: the source is public and you may self-host it, with commercial restrictions set out in the licence."
                >
                    <SettingRow
                        label="Documentation"
                        icon={
                            <Feather name="book-open" size={16} color={theme.colors.textSecondary} />
                        }
                        onPress={() => void WebBrowser.openBrowserAsync(DOCS_URL)}
                    />
                    <SettingRow
                        label="Source code"
                        icon={<Feather name="github" size={16} color={theme.colors.textSecondary} />}
                        onPress={() => void WebBrowser.openBrowserAsync(REPO_URL)}
                    />
                    <SettingRow
                        label="Licence"
                        icon={
                            <Feather name="file-text" size={16} color={theme.colors.textSecondary} />
                        }
                        onPress={() => void WebBrowser.openBrowserAsync(LICENSE_URL)}
                    />
                </Group>

                <Group title="Open source in this app">
                    <NoteRow>
                        <View style={{ gap: theme.spacing.xs }}>
                            <Text variant="caption" tone="tertiary">
                                Built with React Native and Expo. Cryptography by the Noble
                                libraries (@noble/ciphers, @noble/curves, @noble/hashes), with
                                Argon2id by argon2kt; icons by Feather; typeface Inter.
                            </Text>
                            <Text variant="caption" tone="tertiary">
                                Full dependency licences ship with the source repository.
                            </Text>
                        </View>
                    </NoteRow>
                </Group>
            </ScrollView>
        </Screen>
    );
}
