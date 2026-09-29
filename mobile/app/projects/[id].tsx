/**
 * One project: who is on it, what is filed into it, and its conversations.
 *
 * A project (the web app also calls them Solutions) is a container: chats,
 * automations, apps, notebooks and webpages can all be filed into one, and its
 * members can see what is inside. The phone shows all of that and can open the
 * two kinds it has screens for — chats and automations — while naming the rest
 * honestly rather than pretending to a count it cannot open.
 *
 * `GET /:id/resources` returns each section as `null` when its store was
 * unavailable, which the server distinguishes from `[]` on purpose. That
 * distinction is kept here: "could not load" and "none filed" are different
 * facts and a project page that conflates them is lying about an empty shelf.
 */

import { Feather } from '@expo/vector-icons';
import { useQuery } from '@tanstack/react-query';
import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useMemo } from 'react';
import { RefreshControl, ScrollView, View } from 'react-native';

import { useCurrentUser } from '../../src/auth/AuthProvider';
import {
    automateKeys,
    getProject,
    getProjectMembers,
    getProjectResources,
    listDirectory,
    listProjectThreads,
} from '../../src/features/automate/api';
import { StatusIcon } from '../../src/features/automate/components/StatusPill';
import { describeTrigger, triggerIcon } from '../../src/features/automate/format';
import type { ProjectShare } from '../../src/features/automate/types';
import { relativeTime } from '../../src/lib/time';
import { useTheme } from '../../src/theme/ThemeProvider';
import { Avatar, Badge } from '../../src/ui/Badge';
import { Button } from '../../src/ui/Button';
import { Banner, ErrorState, LoadingState, describeError } from '../../src/ui/Feedback';
import { ListRow } from '../../src/ui/List';
import { Screen } from '../../src/ui/Screen';
import { ScreenHeader } from '../../src/ui/ScreenHeader';
import { Card, Divider, Section } from '../../src/ui/Surface';
import { Text } from '../../src/ui/Text';

export default function ProjectDetailScreen() {
    const { id } = useLocalSearchParams<{ id: string }>();
    const theme = useTheme();
    const router = useRouter();
    const me = useCurrentUser();

    const project = useQuery({
        queryKey: automateKeys.project(id),
        queryFn: ({ signal }) => getProject(id, signal),
        enabled: Boolean(id),
    });

    const members = useQuery({
        queryKey: automateKeys.projectMembers(id),
        queryFn: ({ signal }) => getProjectMembers(id, signal),
        enabled: Boolean(id),
    });

    const resources = useQuery({
        queryKey: automateKeys.projectResources(id),
        queryFn: ({ signal }) => getProjectResources(id, signal),
        enabled: Boolean(id),
    });

    const threads = useQuery({
        queryKey: automateKeys.projectThreads(id),
        queryFn: ({ signal }) => listProjectThreads(id, signal),
        enabled: Boolean(id),
    });

    // Names for member ids, when the caller is allowed to see them at all.
    const directory = useQuery({
        queryKey: ['automate', 'directory'],
        queryFn: ({ signal }) => listDirectory(signal),
        staleTime: 10 * 60_000,
        retry: false,
    });

    const nameFor = useMemo(() => {
        const users = new Map(
            (directory.data?.users ?? []).map((user) => [
                user.id,
                user.displayName || user.username || user.email || user.id,
            ]),
        );
        const groups = new Map(
            (directory.data?.groups ?? []).map((group) => [group.id, group.name ?? group.id]),
        );
        return (share: Pick<ProjectShare, 'sharedWithId' | 'sharedWithType'>) =>
            (share.sharedWithType === 'group' ? groups : users).get(share.sharedWithId) ?? null;
    }, [directory.data]);

    if (project.isLoading) {
        return (
            <Screen edges={['top', 'bottom']}>
                <ScreenHeader title="Project" />
                <LoadingState />
            </Screen>
        );
    }

    if (project.isError || !project.data) {
        return (
            <Screen edges={['top', 'bottom']}>
                <ScreenHeader title="Project" />
                <ErrorState
                    error={project.error ?? new Error('This project could not be loaded.')}
                    onRetry={() => void project.refetch()}
                />
            </Screen>
        );
    }

    const detail = project.data;
    const automations = resources.data?.automations ?? null;
    const apps = resources.data?.apps ?? null;
    const chats = (threads.data ?? []).filter((thread) => thread.type === 'direct');
    const agentChats = (threads.data ?? []).length - chats.length;

    return (
        <Screen edges={['top', 'bottom']}>
            <ScreenHeader
                title={detail.name}
                subtitle={detail.role === 'owner' ? 'You own this project' : `You are a ${detail.role}`}
            />

            <ScrollView
                contentContainerStyle={{
                    paddingHorizontal: theme.spacing.lg,
                    paddingBottom: theme.spacing.xxxl,
                    gap: theme.spacing.xl,
                }}
                refreshControl={
                    <RefreshControl
                        refreshing={project.isRefetching || resources.isRefetching}
                        onRefresh={() => {
                            void project.refetch();
                            void resources.refetch();
                            void threads.refetch();
                            void members.refetch();
                        }}
                        tintColor={theme.colors.accentPrimary}
                        colors={[theme.colors.accentPrimary]}
                    />
                }
            >
                {detail.description ? (
                    <Card>
                        <Text variant="body" tone="secondary">
                            {detail.description}
                        </Text>
                    </Card>
                ) : null}

                <Section
                    title="Conversations"
                    subtitle="Chats shared into this project by their owners"
                >
                    <Card padded={false}>
                        {threads.isError ? (
                            <View style={{ padding: theme.spacing.lg }}>
                                <Banner tone="error">{describeError(threads.error).message}</Banner>
                            </View>
                        ) : chats.length === 0 ? (
                            <View style={{ padding: theme.spacing.lg }}>
                                <Text variant="body" tone="tertiary">
                                    No chats have been shared here yet. Sharing re-encrypts a
                                    conversation for the project, which only its owner can do — from
                                    the chat itself.
                                </Text>
                            </View>
                        ) : (
                            chats.map((thread, index) => (
                                <View key={thread.id}>
                                    {index > 0 ? <Divider inset={theme.spacing.lg} /> : null}
                                    <ListRow
                                        title={thread.title || 'Untitled chat'}
                                        subtitle={
                                            thread.updatedAt
                                                ? `Updated ${relativeTime(thread.updatedAt, { suffix: true })}`
                                                : undefined
                                        }
                                        leading={
                                            <Feather
                                                name="message-circle"
                                                size={16}
                                                color={theme.colors.textMuted}
                                            />
                                        }
                                        onPress={() => router.push(`/chat/${thread.id}`)}
                                    />
                                </View>
                            ))
                        )}

                        {/* Agent conversations live in a different store and have
                            no mobile screen; counting them is honest, linking to
                            them would 404. */}
                        {agentChats > 0 ? (
                            <View
                                style={{
                                    paddingHorizontal: theme.spacing.lg,
                                    paddingBottom: theme.spacing.md,
                                }}
                            >
                                <Text variant="caption" tone="tertiary">
                                    {`${agentChats} agent conversation${agentChats === 1 ? '' : 's'} are also here. Those open on the desktop.`}
                                </Text>
                            </View>
                        ) : null}
                    </Card>
                </Section>

                <Section title="Automations">
                    <Card padded={false}>
                        {automations === null ? (
                            <View style={{ padding: theme.spacing.lg }}>
                                <Banner tone="warning">
                                    The automations in this project could not be loaded just now.
                                </Banner>
                            </View>
                        ) : automations.length === 0 ? (
                            <View style={{ padding: theme.spacing.lg }}>
                                <Text variant="body" tone="tertiary">
                                    Nothing filed here yet.
                                </Text>
                            </View>
                        ) : (
                            automations.map((automation, index) => (
                                <View key={automation.id}>
                                    {index > 0 ? <Divider inset={theme.spacing.lg} /> : null}
                                    <ListRow
                                        title={automation.title || 'Untitled automation'}
                                        subtitle={describeTrigger(automation.definition?.trigger)}
                                        wrapTitle
                                        leading={
                                            <Feather
                                                name={triggerIcon(automation.triggerType)}
                                                size={16}
                                                color={
                                                    automation.isActive
                                                        ? theme.colors.accentPrimary
                                                        : theme.colors.textMuted
                                                }
                                            />
                                        }
                                        trailing={
                                            automation.lastStatus ? (
                                                <StatusIcon status={automation.lastStatus} size={16} />
                                            ) : undefined
                                        }
                                        onPress={() => router.push(`/automations/${automation.id}`)}
                                    />
                                </View>
                            ))
                        )}
                    </Card>
                </Section>

                {apps && apps.length > 0 ? (
                    <Section title="Apps">
                        <Card padded={false}>
                            {apps.map((app, index) => (
                                <View key={app.id}>
                                    {index > 0 ? <Divider inset={theme.spacing.lg} /> : null}
                                    <ListRow
                                        title={app.name}
                                        subtitle={app.description || undefined}
                                        wrapTitle
                                        leading={
                                            <Feather
                                                name="layout"
                                                size={16}
                                                color={theme.colors.textMuted}
                                            />
                                        }
                                        onPress={() => router.push(`/apps/${app.id}`)}
                                    />
                                </View>
                            ))}
                        </Card>
                    </Section>
                ) : null}

                {/* Notebooks and webpages are read on the Library tab, so this
                    reports them rather than duplicating a reader here. */}
                <OtherResources
                    notebooks={resources.data?.notebooks ?? null}
                    webpages={resources.data?.webpages ?? null}
                    approvals={resources.data?.approvals ?? null}
                    loading={resources.isLoading}
                />

                <Section title="People">
                    <Card padded={false}>
                        <ListRow
                            title={
                                detail.ownerId === me?.id
                                    ? 'You'
                                    : (nameFor({
                                          sharedWithId: detail.ownerId,
                                          sharedWithType: 'user',
                                      }) ?? 'The owner')
                            }
                            subtitle="Owner"
                            leading={
                                <Avatar
                                    name={
                                        nameFor({
                                            sharedWithId: detail.ownerId,
                                            sharedWithType: 'user',
                                        }) ?? 'Owner'
                                    }
                                    size={32}
                                />
                            }
                            chevron={false}
                        />
                        {(members.data?.members ?? []).map((share) => (
                            <View key={share.id}>
                                <Divider inset={theme.spacing.lg} />
                                <ListRow
                                    title={
                                        share.sharedWithType === 'user' && share.sharedWithId === me?.id
                                            ? 'You'
                                            : (nameFor(share) ??
                                              (share.sharedWithType === 'group'
                                                  ? 'A group'
                                                  : 'A colleague'))
                                    }
                                    subtitle={
                                        share.sharedWithType === 'group'
                                            ? `Group · ${share.permission}`
                                            : share.permission
                                    }
                                    leading={
                                        share.sharedWithType === 'group' ? (
                                            <Feather
                                                name="users"
                                                size={16}
                                                color={theme.colors.textMuted}
                                            />
                                        ) : (
                                            <Avatar name={nameFor(share) ?? '?'} size={32} />
                                        )
                                    }
                                    trailing={<Badge label={share.permission} />}
                                    chevron={false}
                                />
                            </View>
                        ))}
                    </Card>
                    {directory.data && directory.data.users.length === 0 ? (
                        <Text variant="caption" tone="tertiary">
                            Names are only shown to administrators — everyone else sees roles.
                        </Text>
                    ) : null}
                </Section>

                <Button
                    label="Open a chat in this project"
                    variant="secondary"
                    fullWidth
                    onPress={() => router.push('/(tabs)')}
                    accessibilityHint="Goes to Chat. Filing a conversation into a project is done from the conversation itself."
                />
            </ScrollView>
        </Screen>
    );
}

/**
 * Notebooks, webpages and approvals in one line each.
 *
 * Deliberately not a list: their readers live on other tabs, and a row here
 * that opens nothing is worse than a sentence that tells the truth.
 */
function OtherResources({
    notebooks,
    webpages,
    approvals,
    loading,
}: {
    notebooks: unknown[] | null;
    webpages: unknown[] | null;
    approvals: unknown[] | null;
    loading: boolean;
}) {
    const theme = useTheme();
    if (loading) return null;

    const lines = [
        countLine('notebook', notebooks),
        countLine('webpage', webpages),
        countLine('approval', approvals),
    ].filter((line): line is string => Boolean(line));

    if (lines.length === 0) return null;

    return (
        <Section title="Also filed here">
            <Card>
                <View style={{ gap: theme.spacing.xs }}>
                    {lines.map((line) => (
                        <Text key={line} variant="body" tone="secondary">
                            {line}
                        </Text>
                    ))}
                    <Text variant="caption" tone="tertiary">
                        Notebooks and pages are read on the Library tab.
                    </Text>
                </View>
            </Card>
        </Section>
    );
}

function countLine(noun: string, items: unknown[] | null): string | null {
    if (items === null) return `${noun}s could not be loaded`;
    if (items.length === 0) return null;
    return `${items.length} ${items.length === 1 ? noun : `${noun}s`}`;
}
