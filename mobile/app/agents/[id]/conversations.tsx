/**
 * Every conversation you have had with one agent.
 *
 * Separate from the cross-agent list on /agents because the two answer
 * different questions: that one is "where was I", this one is "what have I
 * asked this agent before", and it is the only list that is complete — the
 * cross-agent endpoint is capped at 50 rows server-side while this one is not.
 *
 * Pinned rows float to the top. The server stores `pinned` per conversation
 * but returns rows ordered by `updated_at` only, so the sort happens here.
 *
 * Rename and delete are on a long-press rather than a swipe: a swipe on an
 * inverted-feeling list of chats is easy to trigger by accident, and deleting
 * a conversation is not undoable — `deleteConversationById` drops the row.
 */

import { Feather } from '@expo/vector-icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import React, { useMemo, useState } from 'react';
import { Alert, FlatList, Modal, Pressable, RefreshControl, View } from 'react-native';

import {
    agentKeys,
    deleteAgentConversation,
    getAgent,
    listAgentConversations,
    updateAgentConversation,
} from '../../../src/features/agents/api';
import type { AgentConversationSummary } from '../../../src/features/agents/types';
import { relativeTime } from '../../../src/lib/time';
import { useTheme } from '../../../src/theme/ThemeProvider';
import { Button, IconButton } from '../../../src/ui/Button';
import { EmptyState, ErrorState, ListSkeleton } from '../../../src/ui/Feedback';
import { SearchField, TextField } from '../../../src/ui/Input';
import { ListRow } from '../../../src/ui/List';
import { Screen } from '../../../src/ui/Screen';
import { ScreenHeader } from '../../../src/ui/ScreenHeader';
import { Card } from '../../../src/ui/Surface';
import { Text } from '../../../src/ui/Text';
import { useToast } from '../../../src/ui/Toast';


export default function AgentConversationsScreen() {
    const { id } = useLocalSearchParams<{ id: string }>();
    const theme = useTheme();
    const router = useRouter();
    const queryClient = useQueryClient();
    const { toast } = useToast();
    const [search, setSearch] = useState('');

    // Only for the header. It is almost always already cached from the profile
    // screen, so this rarely costs a request.
    const agent = useQuery({
        queryKey: agentKeys.detail(id),
        queryFn: ({ signal }) => getAgent(id, signal),
        enabled: Boolean(id),
    });

    const query = useQuery({
        queryKey: agentKeys.conversations(id),
        queryFn: ({ signal }) => listAgentConversations(id, signal),
        enabled: Boolean(id),
    });

    const invalidate = () => {
        void queryClient.invalidateQueries({ queryKey: agentKeys.conversations(id) });
        // The cross-agent list shows the same rows; leaving it stale means a
        // conversation you just deleted is still on the Agents screen.
        void queryClient.invalidateQueries({ queryKey: agentKeys.allConversations });
    };

    const pin = useMutation({
        mutationFn: ({ conversationId, pinned }: { conversationId: string; pinned: boolean }) =>
            updateAgentConversation(id, conversationId, { pinned }),
        onSuccess: invalidate,
        onError: () => toast('That did not save', 'error'),
    });

    const rename = useMutation({
        mutationFn: ({ conversationId, title }: { conversationId: string; title: string }) =>
            updateAgentConversation(id, conversationId, { title }),
        onSuccess: invalidate,
        onError: () => toast('That did not save', 'error'),
    });

    const remove = useMutation({
        mutationFn: (conversationId: string) => deleteAgentConversation(id, conversationId),
        onSuccess: () => {
            invalidate();
            toast('Conversation deleted');
        },
        onError: () => toast('That did not delete', 'error'),
    });

    const items = useMemo(() => sortAndFilter(query.data ?? [], search), [query.data, search]);

    /** The conversation being renamed, and its draft title. */
    const [renaming, setRenaming] = useState<{ id: string; title: string } | null>(null);

    const openMenu = (conversation: AgentConversationSummary) => {
        const label = conversation.title || 'Untitled chat';
        // Alert.prompt is iOS-only, so rename opens a modal instead of a third
        // button that would silently do nothing on the only platform we ship.
        Alert.alert(label, undefined, [
            {
                text: conversation.pinned ? 'Unpin' : 'Pin to top',
                onPress: () =>
                    pin.mutate({ conversationId: conversation.id, pinned: !conversation.pinned }),
            },
            {
                text: 'Rename',
                onPress: () => setRenaming({ id: conversation.id, title: label }),
            },
            {
                text: 'Delete',
                style: 'destructive',
                onPress: () => remove.mutate(conversation.id),
            },
            { text: 'Cancel', style: 'cancel' },
        ]);
    };

    return (
        <Screen edges={['top', 'bottom']}>
            <Stack.Screen options={{ headerShown: false }} />

            <ScreenHeader
                title="Conversations"
                subtitle={agent.data?.name ?? undefined}
                actions={
                    <>
                        <IconButton
                            icon={<Feather name="edit" size={20} color={theme.colors.textPrimary} />}
                            accessibilityLabel="Start a new conversation"
                            onPress={() => router.push(`/agents/${id}?c=new`)}
                        />
                    </>
                }
            />

            {(query.data ?? []).length > 0 ? (
                <View style={{ paddingHorizontal: theme.spacing.lg, paddingBottom: theme.spacing.sm }}>
                    <SearchField
                        value={search}
                        onChangeText={setSearch}
                        placeholder="Search these conversations"
                    />
                </View>
            ) : null}

            {query.isLoading ? (
                <ListSkeleton />
            ) : query.isError ? (
                <ErrorState error={query.error} onRetry={() => void query.refetch()} />
            ) : items.length === 0 ? (
                <EmptyState
                    icon="message-square"
                    title={search.trim() ? 'Nothing matches that' : 'No conversations yet'}
                    message={
                        search.trim()
                            ? 'Titles are generated after the first exchange, so a very new chat may not be searchable yet.'
                            : 'Ask this agent something and the conversation is kept here.'
                    }
                    actionLabel={search.trim() ? 'Clear search' : 'Start a conversation'}
                    onAction={
                        search.trim() ? () => setSearch('') : () => router.push(`/agents/${id}?c=new`)
                    }
                />
            ) : (
                <FlatList
                    data={items}
                    keyExtractor={(item) => item.id}
                    refreshControl={
                        <RefreshControl
                            refreshing={query.isRefetching}
                            onRefresh={() => void query.refetch()}
                            tintColor={theme.colors.accentPrimary}
                            colors={[theme.colors.accentPrimary]}
                        />
                    }
                    renderItem={({ item }) => (
                        <ListRow
                            title={item.title || 'Untitled chat'}
                            subtitle={`Started ${relativeTime(item.created_at)}`}
                            meta={relativeTime(item.updated_at)}
                            wrapTitle
                            leading={
                                <Feather
                                    name={item.pinned ? 'bookmark' : 'message-square'}
                                    size={18}
                                    color={
                                        item.pinned
                                            ? theme.colors.accentPrimary
                                            : theme.colors.textMuted
                                    }
                                />
                            }
                            onPress={() => router.push(`/agents/${id}?c=${item.id}`)}
                            onLongPress={() => openMenu(item)}
                        />
                    )}
                    contentContainerStyle={{ paddingBottom: theme.spacing.xxl }}
                />
            )}

            <RenameDialog
                value={renaming}
                onChange={setRenaming}
                onSubmit={(title) => {
                    if (renaming) rename.mutate({ conversationId: renaming.id, title });
                    setRenaming(null);
                }}
            />
        </Screen>
    );
}

function RenameDialog({
    value,
    onChange,
    onSubmit,
}: {
    value: { id: string; title: string } | null;
    onChange: (next: { id: string; title: string } | null) => void;
    onSubmit: (title: string) => void;
}) {
    const theme = useTheme();
    const trimmed = value?.title.trim() ?? '';

    return (
        <Modal
            visible={Boolean(value)}
            transparent
            animationType="fade"
            onRequestClose={() => onChange(null)}
        >
            <Pressable
                onPress={() => onChange(null)}
                accessibilityRole="button"
                accessibilityLabel="Close"
                style={{
                    flex: 1,
                    justifyContent: 'center',
                    padding: theme.spacing.xl,
                    backgroundColor: 'rgba(0,0,0,0.45)',
                }}
            >
                {/* Swallows the backdrop press so a tap inside the card does
                    not dismiss the dialog mid-edit. */}
                <Pressable onPress={() => {}} accessible={false}>
                    <Card>
                        <View style={{ gap: theme.spacing.md }}>
                            <Text variant="heading">Rename conversation</Text>
                            <TextField
                                value={value?.title ?? ''}
                                onChangeText={(title) =>
                                    onChange(value ? { ...value, title } : null)
                                }
                                autoFocus
                                accessibilityLabel="Conversation title"
                                returnKeyType="done"
                                onSubmitEditing={() => trimmed && onSubmit(trimmed)}
                            />
                            <View style={{ flexDirection: 'row', gap: theme.spacing.sm }}>
                                <Button
                                    label="Cancel"
                                    variant="secondary"
                                    onPress={() => onChange(null)}
                                    style={{ flex: 1 }}
                                />
                                <Button
                                    label="Save"
                                    onPress={() => onSubmit(trimmed)}
                                    disabled={!trimmed}
                                    style={{ flex: 1 }}
                                />
                            </View>
                        </View>
                    </Card>
                </Pressable>
            </Pressable>
        </Modal>
    );
}

/**
 * Pinned first, then newest. `listConversations` orders by `updated_at` only
 * (server/stores/agent/agentConversations.js), so pinning has no effect on the
 * wire order and has to be applied here.
 */
function sortAndFilter(
    items: AgentConversationSummary[],
    search: string,
): AgentConversationSummary[] {
    const needle = search.trim().toLowerCase();
    const filtered = needle
        ? items.filter((item) => (item.title ?? '').toLowerCase().includes(needle))
        : items;
    return filtered.slice().sort((a, b) => {
        if (Boolean(a.pinned) !== Boolean(b.pinned)) return a.pinned ? -1 : 1;
        return new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime();
    });
}
