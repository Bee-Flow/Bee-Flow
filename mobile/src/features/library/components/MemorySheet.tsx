/**
 * What Bee Flow remembers about you.
 *
 * Memory is the part of an AI product people are most entitled to be uneasy
 * about, so this screen is built around inspection rather than around adding:
 * every row is readable in full, every row can be deleted on the spot, and the
 * type is always visible so "why does it think that?" has an answer.
 *
 * The list is server-paged and server-searched (routes/memory.js falls through
 * to memoryStore.searchUserMemories for the user-global view), because a
 * long-lived account accumulates hundreds of rows and filtering them on the
 * phone would mean downloading all of them first.
 */

import { Feather } from '@expo/vector-icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import React, { useState } from 'react';
import { FlatList, RefreshControl, StyleSheet, View } from 'react-native';

import { relativeTime } from '../../../lib/time';
import { useTheme } from '../../../theme/ThemeProvider';
import { Badge, Chip } from '../../../ui/Badge';
import { Button, IconButton } from '../../../ui/Button';
import { EmptyState, ErrorState, ListSkeleton } from '../../../ui/Feedback';
import { SearchField, TextField } from '../../../ui/Input';
import { ConfirmSheet, Sheet } from '../../../ui/Sheet';
import { Text } from '../../../ui/Text';
import { useToast } from '../../../ui/Toast';
import { deleteMemory, createMemory, libraryKeys, listMemories, memoryLine } from '../api';
import { MEMORY_TYPES, type Memory } from '../types';

export function MemorySheet({ visible, onClose }: { visible: boolean; onClose: () => void }) {
    const theme = useTheme();
    const queryClient = useQueryClient();
    const { toast } = useToast();

    const [search, setSearch] = useState('');
    const [type, setType] = useState<string | null>(null);
    const [adding, setAdding] = useState(false);
    const [draft, setDraft] = useState('');
    const [pendingDelete, setPendingDelete] = useState<Memory | null>(null);

    const query = useQuery({
        queryKey: libraryKeys.memory(search, type),
        queryFn: ({ signal }) => listMemories({ search, type, limit: 100 }, signal),
        enabled: visible,
    });

    const invalidate = () => {
        void queryClient.invalidateQueries({ queryKey: ['library', 'memory'] });
    };

    const remove = useMutation({
        mutationFn: (id: string) => deleteMemory(id),
        onSuccess: () => {
            toast('Forgotten', 'success');
            setPendingDelete(null);
            invalidate();
        },
    });

    const add = useMutation({
        mutationFn: (content: string) => createMemory(content, 'instruction'),
        onSuccess: () => {
            toast('Saved', 'success');
            setDraft('');
            setAdding(false);
            invalidate();
        },
    });

    const memories = query.data?.memories ?? [];

    return (
        <>
            <Sheet
                visible={visible}
                onClose={onClose}
                title="Memory"
                subtitle={
                    query.data?.total !== undefined
                        ? `${query.data.total} thing${query.data.total === 1 ? '' : 's'} remembered`
                        : 'What Bee Flow carries between conversations'
                }
                scroll={false}
                tall
                footer={
                    adding ? undefined : (
                        <Button
                            label="Add an instruction"
                            variant="secondary"
                            fullWidth
                            onPress={() => setAdding(true)}
                            icon={<Feather name="plus" size={16} color={theme.colors.textPrimary} />}
                        />
                    )
                }
            >
                <View style={{ flexShrink: 1 }}>
                    {adding ? (
                        <View style={{ paddingHorizontal: theme.spacing.lg, gap: theme.spacing.md }}>
                            <TextField
                                label="Always remember"
                                value={draft}
                                onChangeText={setDraft}
                                multiline
                                maxLines={5}
                                autoFocus
                                placeholder="Answer in Dutch unless I write in English."
                                hint="Stored as an instruction. Every agent that reads your memory will see it."
                            />
                            <View style={{ flexDirection: 'row', gap: theme.spacing.sm }}>
                                <Button
                                    label="Save"
                                    onPress={() => add.mutate(draft.trim())}
                                    loading={add.isPending}
                                    disabled={draft.trim().length < 3}
                                    style={{ flex: 1 }}
                                />
                                <Button
                                    label="Cancel"
                                    variant="ghost"
                                    onPress={() => {
                                        setAdding(false);
                                        setDraft('');
                                    }}
                                    style={{ flex: 1 }}
                                />
                            </View>
                            {add.isError ? (
                                <Text variant="caption" tone="error" accessibilityLiveRegion="polite">
                                    {(add.error as Error).message}
                                </Text>
                            ) : null}
                        </View>
                    ) : null}

                    <View style={{ paddingHorizontal: theme.spacing.lg, paddingBottom: theme.spacing.sm }}>
                        <SearchField
                            value={search}
                            onChangeText={setSearch}
                            placeholder="Search memory"
                        />
                    </View>

                    <FlatList
                        horizontal
                        data={['all', ...MEMORY_TYPES]}
                        keyExtractor={(t) => t}
                        showsHorizontalScrollIndicator={false}
                        contentContainerStyle={{
                            paddingHorizontal: theme.spacing.lg,
                            gap: theme.spacing.sm,
                            paddingBottom: theme.spacing.md,
                        }}
                        renderItem={({ item }) => (
                            <Chip
                                label={item === 'all' ? 'All' : capitalise(item)}
                                selected={item === 'all' ? type === null : type === item}
                                onPress={() => setType(item === 'all' ? null : item)}
                            />
                        )}
                    />

                    {query.isLoading ? (
                        <ListSkeleton rows={5} />
                    ) : query.isError ? (
                        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
                    ) : memories.length === 0 ? (
                        <EmptyState
                            icon="cpu"
                            title={search ? 'Nothing matches that' : 'Nothing remembered yet'}
                            message={
                                search
                                    ? 'Try a different word.'
                                    : 'Bee Flow saves things you tell it to remember, and things it works out from your chats.'
                            }
                        />
                    ) : (
                        <FlatList
                            data={memories}
                            keyExtractor={(m) => m.id}
                            refreshControl={
                                <RefreshControl
                                    refreshing={query.isRefetching}
                                    onRefresh={() => void query.refetch()}
                                    tintColor={theme.colors.accentPrimary}
                                    colors={[theme.colors.accentPrimary]}
                                />
                            }
                            contentContainerStyle={{ paddingBottom: theme.spacing.xl }}
                            renderItem={({ item }) => (
                                <MemoryRow memory={item} onDelete={() => setPendingDelete(item)} />
                            )}
                        />
                    )}
                </View>
            </Sheet>

            <ConfirmSheet
                visible={Boolean(pendingDelete)}
                title="Forget this?"
                message={pendingDelete ? memoryLine(pendingDelete) : ''}
                confirmLabel="Forget"
                busy={remove.isPending}
                onCancel={() => setPendingDelete(null)}
                onConfirm={() => pendingDelete && remove.mutate(pendingDelete.id)}
            />
        </>
    );
}

function MemoryRow({ memory, onDelete }: { memory: Memory; onDelete: () => void }) {
    const theme = useTheme();
    return (
        <View
            style={{
                flexDirection: 'row',
                alignItems: 'flex-start',
                gap: theme.spacing.md,
                paddingHorizontal: theme.spacing.lg,
                paddingVertical: theme.spacing.md,
                borderTopWidth: StyleSheet.hairlineWidth,
                borderTopColor: theme.colors.borderSubtle,
            }}
        >
            <View style={{ flex: 1, gap: theme.spacing.xs }}>
                <Text variant="body" selectable>
                    {memoryLine(memory)}
                </Text>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm }}>
                    <Badge
                        label={capitalise(memory.type)}
                        tone={memory.importance >= 0.8 ? 'accent' : 'neutral'}
                    />
                    <Text variant="label" tone="tertiary">
                        {relativeTime(memory.updated_at)}
                    </Text>
                </View>
            </View>
            <IconButton
                icon={<Feather name="trash-2" size={16} color={theme.colors.textMuted} />}
                accessibilityLabel={`Forget: ${memoryLine(memory).slice(0, 60)}`}
                onPress={onDelete}
            />
        </View>
    );
}

function capitalise(value: string): string {
    return value.charAt(0).toUpperCase() + value.slice(1);
}
