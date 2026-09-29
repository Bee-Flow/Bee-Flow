/**
 * Notebooks.
 *
 * The list is paged, searched and filtered on the server — routes/notebooks.js
 * whitelists `search`, `sort` and `filter` and returns a card projection with
 * counts and a cached preview rather than document bodies. Doing any of it on
 * the phone would mean downloading every notebook to type three letters, which
 * is the bug the server route was fixed to avoid.
 *
 * "Processing" is a first-class filter rather than a detail, because an
 * ingestion that quietly failed is the single most common reason a notebook
 * answers badly, and the card counts are the only place it shows.
 */

import { Feather } from '@expo/vector-icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Stack, useRouter } from 'expo-router';
import React, { useState } from 'react';
import { FlatList, Pressable, RefreshControl, View } from 'react-native';

import {
    createNotebook,
    deleteNotebook,
    libraryKeys,
    listNotebooks,
    type NotebookFilter,
} from '../../src/features/library/api';
import { countLabel } from '../../src/features/library/format';
import type { NotebookCard } from '../../src/features/library/types';
import { plural } from '../../src/lib/format';
import { relativeTime } from '../../src/lib/time';
import { useTheme } from '../../src/theme/ThemeProvider';
import { Badge, Chip } from '../../src/ui/Badge';
import { Button } from '../../src/ui/Button';
import { EmptyState, ErrorState, ListSkeleton } from '../../src/ui/Feedback';
import { SearchField, TextField } from '../../src/ui/Input';
import { ListRow } from '../../src/ui/List';
import { Screen } from '../../src/ui/Screen';
import { ScreenHeader } from '../../src/ui/ScreenHeader';
import { ConfirmSheet, Sheet } from '../../src/ui/Sheet';
import { Text } from '../../src/ui/Text';
import { useToast } from '../../src/ui/Toast';

const FILTERS: { key: NotebookFilter; label: string }[] = [
    { key: 'all', label: 'All' },
    { key: 'pinned', label: 'Pinned' },
    { key: 'processing', label: 'Processing' },
    { key: 'sources', label: 'With sources' },
    { key: 'chat', label: 'With chat' },
];

export default function NotebooksScreen() {
    const theme = useTheme();
    const router = useRouter();
    const queryClient = useQueryClient();
    const { toast } = useToast();

    const [search, setSearch] = useState('');
    const [filter, setFilter] = useState<NotebookFilter>('all');
    const [creating, setCreating] = useState(false);
    const [name, setName] = useState('');
    const [pendingDelete, setPendingDelete] = useState<NotebookCard | null>(null);

    const query = useQuery({
        queryKey: [...libraryKeys.notebooks(search.trim()), filter],
        queryFn: ({ signal }) =>
            listNotebooks({ search: search.trim(), filter, sort: 'activity', limit: 60 }, signal),
    });

    const create = useMutation({
        mutationFn: (value: string) => createNotebook({ name: value }),
        onSuccess: (notebook) => {
            setCreating(false);
            setName('');
            void queryClient.invalidateQueries({ queryKey: ['library', 'notebooks'] });
            if (notebook?.id) router.push(`/notebooks/${notebook.id}`);
        },
    });

    const remove = useMutation({
        mutationFn: (id: string) => deleteNotebook(id),
        onSuccess: () => {
            toast('Notebook deleted', 'success');
            setPendingDelete(null);
            void queryClient.invalidateQueries({ queryKey: ['library', 'notebooks'] });
        },
    });

    const notebooks = query.data?.notebooks ?? [];

    return (
        <Screen edges={['top', 'bottom']}>
            <Stack.Screen options={{ headerShown: false }} />

            <ScreenHeader
                title="Notebooks"
            />

            <View style={{ paddingHorizontal: theme.spacing.lg, paddingBottom: theme.spacing.sm }}>
                <SearchField
                    value={search}
                    onChangeText={setSearch}
                    placeholder="Search notebooks"
                />
            </View>

            <FlatList
                horizontal
                data={FILTERS}
                keyExtractor={(f) => f.key}
                showsHorizontalScrollIndicator={false}
                style={{ flexGrow: 0 }}
                contentContainerStyle={{
                    paddingHorizontal: theme.spacing.lg,
                    gap: theme.spacing.sm,
                    paddingBottom: theme.spacing.md,
                }}
                renderItem={({ item }) => (
                    <Chip
                        label={item.label}
                        selected={filter === item.key}
                        onPress={() => setFilter(item.key)}
                    />
                )}
            />

            {query.isLoading ? (
                <ListSkeleton />
            ) : query.isError ? (
                <ErrorState error={query.error} onRetry={() => void query.refetch()} />
            ) : notebooks.length === 0 ? (
                <EmptyState
                    icon="book"
                    title={search ? 'No notebooks match that' : 'No notebooks yet'}
                    message={
                        search
                            ? 'Try a different word, or clear the filter.'
                            : 'A notebook gathers sources — files, scans, links, meetings — and lets you ask questions across all of them at once.'
                    }
                    actionLabel={search ? undefined : 'New notebook'}
                    onAction={search ? undefined : () => setCreating(true)}
                />
            ) : (
                <FlatList
                    data={notebooks}
                    keyExtractor={(nb) => nb.id}
                    refreshControl={
                        <RefreshControl
                            refreshing={query.isRefetching}
                            onRefresh={() => void query.refetch()}
                            tintColor={theme.colors.accentPrimary}
                            colors={[theme.colors.accentPrimary]}
                        />
                    }
                    contentContainerStyle={{ paddingBottom: 96 }}
                    renderItem={({ item }) => (
                        <ListRow
                            title={item.name}
                            subtitle={
                                item.description ||
                                item.preview ||
                                countLabel([plural(item.sourceCount, 'source')])
                            }
                            meta={relativeTime(item.lastActivityAt ?? item.updatedAt)}
                            wrapTitle
                            leading={
                                <Feather
                                    name={item.pinned ? 'bookmark' : 'book'}
                                    size={18}
                                    color={item.pinned ? theme.colors.accentPrimary : theme.colors.textMuted}
                                />
                            }
                            trailing={
                                item.failedCount > 0 ? (
                                    <Badge label={`${item.failedCount} failed`} tone="error" />
                                ) : item.processingCount > 0 ? (
                                    <Badge label={`${item.processingCount} working`} tone="warning" />
                                ) : undefined
                            }
                            onPress={() => router.push(`/notebooks/${item.id}`)}
                            onLongPress={() => setPendingDelete(item)}
                        />
                    )}
                />
            )}

            <Pressable
                onPress={() => setCreating(true)}
                accessibilityRole="button"
                accessibilityLabel="New notebook"
                style={{
                    position: 'absolute',
                    right: theme.spacing.lg,
                    bottom: theme.spacing.xl,
                    width: 56,
                    height: 56,
                    borderRadius: 28,
                    alignItems: 'center',
                    justifyContent: 'center',
                    backgroundColor: theme.colors.accentPrimary,
                    ...theme.elevation.raised,
                }}
            >
                <Feather name="plus" size={24} color={theme.colors.accentPrimaryFg} />
            </Pressable>

            <Sheet
                visible={creating}
                onClose={() => setCreating(false)}
                title="New notebook"
                subtitle="You can add sources once it exists"
            >
                <TextField
                    label="Name"
                    value={name}
                    onChangeText={setName}
                    autoFocus
                    placeholder="Q3 supplier review"
                    onSubmitEditing={() => name.trim() && create.mutate(name.trim())}
                />
                {create.isError ? (
                    <Text variant="caption" tone="error" accessibilityLiveRegion="polite">
                        {(create.error as Error).message}
                    </Text>
                ) : null}
                <Button
                    label="Create"
                    fullWidth
                    loading={create.isPending}
                    disabled={name.trim().length === 0}
                    onPress={() => create.mutate(name.trim())}
                />
            </Sheet>

            <ConfirmSheet
                visible={Boolean(pendingDelete)}
                title={`Delete “${pendingDelete?.name ?? ''}”?`}
                message="Its sources, their extracted text and the knowledge base built from them are all removed. This cannot be undone."
                confirmLabel="Delete notebook"
                busy={remove.isPending}
                onCancel={() => setPendingDelete(null)}
                onConfirm={() => pendingDelete && remove.mutate(pendingDelete.id)}
            />
        </Screen>
    );
}
