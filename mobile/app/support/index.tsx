/**
 * Help and support.
 *
 * A support request from a phone is usually written in the two minutes after
 * something went wrong, so this screen optimises for that: one field for the
 * subject, one for what happened, and the version details attached
 * automatically — the thing every support thread has to ask for and nobody
 * knows off the top of their head.
 *
 * Threads are read and replied to in place. `POST /api/support/threads` with
 * `source: 'in_app'` skips the marketing form's spam heuristic (the honeypot
 * and minimum render age in routes/support/threads.js), and the first reply is
 * usually the AI responder — `author_kind` distinguishes it from a human, so
 * the screen says which one answered rather than letting someone thank a
 * machine for a personal touch.
 */

import { Feather } from '@expo/vector-icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as Application from 'expo-application';
import Constants from 'expo-constants';
import * as WebBrowser from 'expo-web-browser';
import React, { useState } from 'react';
import { RefreshControl, ScrollView, View } from 'react-native';

import { checkHealth, getServerUrl } from '../../src/api/server';
import { useAuth } from '../../src/auth/AuthProvider';
import {
    createSupportThread,
    getSupportThread,
    listMySupportThreads,
    replyToSupportThread,
    settingsKeys,
} from '../../src/features/settings/api';
import { humanise } from '../../src/features/settings/format';
import { relativeTime } from '../../src/lib/time';
import { useTheme } from '../../src/theme/ThemeProvider';
import { Badge } from '../../src/ui/Badge';
import { Button } from '../../src/ui/Button';
import {
    Banner,
    describeError,
    EmptyState,
    ListSkeleton,
    LoadingState,
} from '../../src/ui/Feedback';
import { Group, NoteRow } from '../../src/ui/Group';
import { TextField } from '../../src/ui/Input';
import { ListRow, SettingRow } from '../../src/ui/List';
import { Screen } from '../../src/ui/Screen';
import { ScreenHeader } from '../../src/ui/ScreenHeader';
import { Sheet } from '../../src/ui/Sheet';
import { Text } from '../../src/ui/Text';
import { useToast } from '../../src/ui/Toast';

const DOCS_URL = 'https://docs.beeflow.ai/';

/** The statuses `support_threads.status` is constrained to, in words. */
const STATUS_COPY: Record<string, { label: string; tone: 'neutral' | 'accent' | 'success' | 'warning' }> = {
    open: { label: 'Open', tone: 'warning' },
    ai_responding: { label: 'Bee Flow is answering', tone: 'accent' },
    awaiting_user: { label: 'Waiting for you', tone: 'warning' },
    awaiting_agent: { label: 'With support', tone: 'accent' },
    resolved: { label: 'Resolved', tone: 'success' },
    closed: { label: 'Closed', tone: 'neutral' },
};

export default function SupportScreen() {
    const theme = useTheme();
    const queryClient = useQueryClient();
    const { toast } = useToast();
    const { user } = useAuth();

    const [composing, setComposing] = useState(false);
    const [openThreadId, setOpenThreadId] = useState<string | null>(null);

    const threads = useQuery({
        queryKey: settingsKeys.supportThreads,
        queryFn: ({ signal }) => listMySupportThreads(signal),
        retry: false,
    });

    // The support module is optional (`requireModule('support')`), so a
    // self-host without it answers 404, which api.ts folds to null. That is a
    // different thing from "you have no threads" and reads differently below.
    const supportUnavailable = threads.isSuccess && threads.data === null;

    return (
        <Screen edges={['top']} inset>
            <ScreenHeader
                title="Help"
                subtitle={user?.email ?? undefined}
                actions={
                    supportUnavailable ? undefined : (
                        <Button label="Ask" onPress={() => setComposing(true)} size="md" />
                    )
                }
            />

            <ScrollView
                refreshControl={
                    <RefreshControl
                        refreshing={threads.isRefetching}
                        onRefresh={() => void threads.refetch()}
                        tintColor={theme.colors.accentPrimary}
                        colors={[theme.colors.accentPrimary]}
                    />
                }
                contentContainerStyle={{
                    padding: theme.spacing.lg,
                    gap: theme.spacing.xl,
                    paddingBottom: theme.spacing.xxxl,
                }}
            >
                <Group title="Find an answer yourself">
                    <SettingRow
                        label="Documentation"
                        icon={
                            <Feather name="book-open" size={16} color={theme.colors.textSecondary} />
                        }
                        onPress={() => void WebBrowser.openBrowserAsync(DOCS_URL)}
                    />
                    <SettingRow
                        label="What changed recently"
                        icon={<Feather name="git-commit" size={16} color={theme.colors.textSecondary} />}
                        onPress={() => void WebBrowser.openBrowserAsync(`${DOCS_URL}`)}
                    />
                </Group>

                {supportUnavailable ? (
                    <Group title="Support requests">
                        <NoteRow>
                            <View style={{ gap: theme.spacing.xs }}>
                                <Text variant="body">Not enabled on this server</Text>
                                <Text variant="caption" tone="tertiary">
                                    The support module is not installed here, so requests cannot be
                                    filed from inside the app. Your administrator is the right
                                    person to ask — or the documentation above may already cover it.
                                </Text>
                            </View>
                        </NoteRow>
                    </Group>
                ) : threads.isLoading ? (
                    <ListSkeleton rows={3} />
                ) : threads.isError ? (
                    <Banner tone="error">{describeError(threads.error).message}</Banner>
                ) : threads.data && threads.data.length > 0 ? (
                    <Group
                        title="Your requests"
                        footer="Bee Flow answers most questions itself within a minute or two, and hands anything it cannot to a person."
                    >
                        {threads.data.map((thread) => {
                            const status = STATUS_COPY[thread.status] ?? {
                                label: humanise(thread.status),
                                tone: 'neutral' as const,
                            };
                            return (
                                <ListRow
                                    key={thread.id}
                                    title={thread.subject}
                                    subtitle={`${status.label} · ${relativeTime(thread.last_message_at ?? thread.created_at)}`}
                                    wrapTitle
                                    onPress={() => setOpenThreadId(thread.id)}
                                    leading={
                                        <Feather
                                            name={
                                                thread.status === 'resolved' ||
                                                thread.status === 'closed'
                                                    ? 'check-circle'
                                                    : 'message-circle'
                                            }
                                            size={16}
                                            color={
                                                thread.status === 'resolved'
                                                    ? theme.colors.success
                                                    : theme.colors.textMuted
                                            }
                                        />
                                    }
                                    trailing={<Badge label={status.label} tone={status.tone} />}
                                />
                            );
                        })}
                    </Group>
                ) : (
                    <EmptyState
                        icon="life-buoy"
                        title="No requests yet"
                        message="Ask anything — how something works, or what went wrong. Bee Flow attaches your version details so nobody has to ask for them."
                        actionLabel="Ask a question"
                        onAction={() => setComposing(true)}
                    />
                )}
            </ScrollView>

            <ComposeSheet
                visible={composing}
                onClose={() => setComposing(false)}
                onFiled={() => {
                    setComposing(false);
                    void queryClient.invalidateQueries({ queryKey: settingsKeys.supportThreads });
                    toast('Request sent', 'success');
                }}
            />

            <ThreadSheet
                threadId={openThreadId}
                onClose={() => setOpenThreadId(null)}
            />
        </Screen>
    );
}

function ComposeSheet({
    visible,
    onClose,
    onFiled,
}: {
    visible: boolean;
    onClose: () => void;
    onFiled: () => void;
}) {
    const theme = useTheme();
    const [subject, setSubject] = useState('');
    const [message, setMessage] = useState('');
    const [attachDetails, setAttachDetails] = useState(true);

    const server = getServerUrl();
    const health = useQuery({
        queryKey: settingsKeys.health,
        queryFn: () => (server ? checkHealth(server) : Promise.resolve(null)),
        enabled: visible,
        staleTime: 60_000,
        retry: false,
    });

    const mutation = useMutation({
        mutationFn: () =>
            createSupportThread({
                subject: subject.trim(),
                message: attachDetails
                    ? `${message.trim()}\n\n---\n${diagnostics(health.data?.appVersion)}`
                    : message.trim(),
            }),
        onSuccess: () => {
            setSubject('');
            setMessage('');
            onFiled();
        },
    });

    return (
        <Sheet
            visible={visible}
            onClose={onClose}
            title="Ask for help"
            subtitle="Bee Flow answers first; a person takes over if it cannot"
            footer={
                <Button
                    label="Send"
                    onPress={() => mutation.mutate()}
                    disabled={subject.trim().length === 0 || message.trim().length === 0}
                    loading={mutation.isPending}
                    fullWidth
                />
            }
        >
            <View style={{ gap: theme.spacing.md }}>
                {mutation.isError ? (
                    <Banner tone="error">{describeError(mutation.error).message}</Banner>
                ) : null}
                <TextField
                    label="What is this about?"
                    value={subject}
                    onChangeText={setSubject}
                    maxLength={200}
                    placeholder="Recording will not upload"
                />
                <TextField
                    label="What happened?"
                    value={message}
                    onChangeText={setMessage}
                    multiline
                    maxLines={8}
                    maxLength={5000}
                    placeholder="What you did, what you expected, and what happened instead."
                />
                <Button
                    label={
                        attachDetails
                            ? 'Version details will be attached'
                            : 'Version details will not be attached'
                    }
                    variant="ghost"
                    onPress={() => setAttachDetails((v) => !v)}
                    icon={
                        <Feather
                            name={attachDetails ? 'check-square' : 'square'}
                            size={16}
                            color={theme.colors.textSecondary}
                        />
                    }
                />
                <Text variant="caption" tone="tertiary">
                    Your message and, if you leave it on, your app and server versions are sent.
                    Nothing else — no chat contents, no files.
                </Text>
            </View>
        </Sheet>
    );
}

function ThreadSheet({ threadId, onClose }: { threadId: string | null; onClose: () => void }) {
    const theme = useTheme();
    const queryClient = useQueryClient();
    const [reply, setReply] = useState('');

    const thread = useQuery({
        queryKey: settingsKeys.supportThread(threadId ?? 'none'),
        queryFn: ({ signal }) => (threadId ? getSupportThread(threadId, signal) : Promise.resolve(null)),
        enabled: Boolean(threadId),
        // While Bee Flow's own responder is drafting, the thread changes
        // without the user doing anything — so it is polled rather than
        // fetched once, and only while the sheet is open.
        refetchInterval: (query) =>
            query.state.data?.thread.status === 'ai_responding' ? 5_000 : false,
    });

    const send = useMutation({
        mutationFn: () => replyToSupportThread(threadId ?? '', reply.trim()),
        onSuccess: () => {
            setReply('');
            void queryClient.invalidateQueries({
                queryKey: settingsKeys.supportThread(threadId ?? 'none'),
            });
            void queryClient.invalidateQueries({ queryKey: settingsKeys.supportThreads });
        },
    });

    const closed =
        thread.data?.thread.status === 'closed' || thread.data?.thread.status === 'resolved';

    return (
        <Sheet
            visible={threadId !== null}
            onClose={onClose}
            title={thread.data?.thread.subject ?? 'Request'}
            subtitle={
                thread.data
                    ? (STATUS_COPY[thread.data.thread.status]?.label ??
                      humanise(thread.data.thread.status))
                    : undefined
            }
            footer={
                closed ? (
                    <Text variant="caption" tone="tertiary" center>
                        This request is closed. Ask a new question if something else comes up.
                    </Text>
                ) : (
                    <View style={{ gap: theme.spacing.sm }}>
                        <TextField
                            value={reply}
                            onChangeText={setReply}
                            placeholder="Reply"
                            multiline
                            maxLines={4}
                            maxLength={10_000}
                            accessibilityLabel="Reply to this request"
                        />
                        <Button
                            label="Send reply"
                            onPress={() => send.mutate()}
                            disabled={reply.trim().length === 0}
                            loading={send.isPending}
                            fullWidth
                        />
                    </View>
                )
            }
        >
            {thread.isLoading ? (
                <LoadingState />
            ) : thread.isError ? (
                <Banner tone="error">{describeError(thread.error).message}</Banner>
            ) : thread.data ? (
                <View style={{ gap: theme.spacing.lg }}>
                    {send.isError ? (
                        <Banner tone="error">{describeError(send.error).message}</Banner>
                    ) : null}
                    {thread.data.messages.map((entry) => (
                        <View key={entry.id} style={{ gap: theme.spacing.xs }}>
                            <View
                                style={{
                                    flexDirection: 'row',
                                    alignItems: 'center',
                                    gap: theme.spacing.sm,
                                }}
                            >
                                <Text variant="caption" weight="semibold">
                                    {authorName(entry.author_kind, entry.author_display)}
                                </Text>
                                {entry.author_kind === 'ai' ? (
                                    <Badge label="Automated" tone="accent" />
                                ) : null}
                                <Text variant="label" tone="tertiary">
                                    {relativeTime(entry.created_at)}
                                </Text>
                            </View>
                            <View
                                style={{
                                    padding: theme.spacing.md,
                                    borderRadius: theme.radii.md,
                                    backgroundColor:
                                        entry.author_kind === 'requester'
                                            ? theme.colors.userBubbleBg
                                            : theme.colors.bgTertiary,
                                }}
                            >
                                <Text variant="body" selectable>
                                    {entry.body}
                                </Text>
                            </View>
                        </View>
                    ))}
                </View>
            ) : null}
        </Sheet>
    );
}

/** 'ai' is Bee Flow's own responder; 'staff' is a person at Bee Flow. */
function authorName(kind: string, display: string | null | undefined): string {
    if (kind === 'ai') return 'Bee Flow';
    if (kind === 'system') return 'System';
    return display || (kind === 'staff' ? 'Bee Flow Support' : 'You');
}

/** The block every support thread would otherwise have to ask for. */
function diagnostics(serverVersion: string | undefined): string {
    const extra = (Constants.expoConfig?.extra ?? {}) as { commitSha?: string; buildProfile?: string };
    return [
        `App: ${Constants.expoConfig?.version ?? '?'} (${Application.nativeBuildVersion ?? '?'})`,
        `Profile: ${extra.buildProfile ?? 'development'}`,
        `App commit: ${extra.commitSha || 'not stamped'}`,
        `Server: ${getServerUrl() ?? 'not configured'}`,
        `Server commit: ${serverVersion || 'not reported'}`,
        'Client: Bee Flow for Android',
    ].join('\n');
}
