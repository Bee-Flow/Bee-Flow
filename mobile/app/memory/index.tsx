/**
 * What Bee Flow remembers about you.
 *
 * Memory is the part of an AI product people are most entitled to be uneasy
 * about, so this screen is built around reading and forgetting rather than
 * around adding: every entry is readable in full, every entry can be forgotten
 * on the spot, several at once, or all of them — and each confirmation says in
 * plain words what disappears. A memory screen that cannot forget is the wrong
 * screen.
 *
 * The list is server-paged and server-searched (routes/memory.js falls through
 * to memoryStore.searchUserMemories for the user-global view) because the
 * alternative is downloading a year of someone's most personal rows onto a
 * phone in order to filter them there.
 *
 * Scope, stated once because the confirmations depend on it: this view is the
 * user-global pool — `project_id IS NULL`. Memories a team shares on a project
 * are a different pool with different access rules, and nothing here touches
 * them, including "Forget everything".
 */

import { Feather } from '@expo/vector-icons';
import {
    useInfiniteQuery,
    useMutation,
    useQuery,
    useQueryClient,
} from '@tanstack/react-query';
import React, { useEffect, useMemo, useState } from 'react';
import { FlatList, RefreshControl, ScrollView, View } from 'react-native';

import {
    MEMORY_PAGE_SIZE,
    bulkDeleteMemories,
    clearAllMemories,
    countsByType,
    deleteMemory,
    getMemoryStats,
    listMemories,
    memoryKeys,
    memoryLine,
} from '../../src/features/memory/api';
import { MemoryRow } from '../../src/features/memory/components/MemoryRow';
import { MEMORY_TYPES, memoryTypeLabel, type Memory } from '../../src/features/memory/types';
import { useTheme } from '../../src/theme/ThemeProvider';
import { Chip } from '../../src/ui/Badge';
import { IconButton } from '../../src/ui/Button';
import { EmptyState, ErrorState, ListSkeleton, Spinner } from '../../src/ui/Feedback';
import { SearchField } from '../../src/ui/Input';
import { Screen } from '../../src/ui/Screen';
import { ScreenHeader } from '../../src/ui/ScreenHeader';
import { ConfirmSheet } from '../../src/ui/Sheet';
import { Text } from '../../src/ui/Text';
import { useToast } from '../../src/ui/Toast';

export default function MemoryScreen() {
    const theme = useTheme();
    const queryClient = useQueryClient();
    const { toast } = useToast();

    const [search, setSearch] = useState('');
    const [debounced, setDebounced] = useState('');
    const [type, setType] = useState<string | null>(null);
    const [expandedId, setExpandedId] = useState<string | null>(null);
    const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
    const [pendingDelete, setPendingDelete] = useState<Memory | null>(null);
    const [confirmBulk, setConfirmBulk] = useState(false);
    const [confirmClear, setConfirmClear] = useState(false);

    // The search hits the database on every change of `debounced`, so the
    // field's own value is kept separate and only settles after a pause.
    useEffect(() => {
        const timer = setTimeout(() => setDebounced(search.trim()), 300);
        return () => clearTimeout(timer);
    }, [search]);

    const stats = useQuery({
        queryKey: memoryKeys.stats,
        queryFn: ({ signal }) => getMemoryStats(signal),
    });

    const list = useInfiniteQuery({
        queryKey: memoryKeys.list(debounced, type),
        queryFn: ({ pageParam, signal }) =>
            listMemories({ search: debounced, type, limit: MEMORY_PAGE_SIZE, offset: pageParam }, signal),
        initialPageParam: 0,
        // `hasMore` is the server's own arithmetic (offset + returned < total);
        // trusting it rather than recomputing keeps the two in step if the
        // route's paging ever changes.
        getNextPageParam: (last) =>
            last.hasMore ? last.offset + last.memories.length : undefined,
    });

    const memories = useMemo(
        () => (list.data?.pages ?? []).flatMap((page) => page.memories),
        [list.data],
    );
    const filtered = Boolean(debounced || type);
    const matchCount = list.data?.pages[0]?.total ?? memories.length;
    const total = stats.data?.total ?? matchCount;

    const invalidate = (): void => {
        void queryClient.invalidateQueries({ queryKey: memoryKeys.all });
    };

    const clearSelection = (): void => setSelected(new Set());

    const removeOne = useMutation({
        mutationFn: (id: string) => deleteMemory(id),
        onSuccess: () => {
            toast('Forgotten', 'success');
            setPendingDelete(null);
            invalidate();
        },
        onError: (error) =>
            toast(error instanceof Error ? error.message : 'Could not forget that', 'error'),
    });

    const removeMany = useMutation({
        mutationFn: (ids: string[]) => bulkDeleteMemories(ids),
        onSuccess: (deleted) => {
            // The route silently skips rows the caller may not touch, so the
            // count it returns is the truth — never the number we asked for.
            toast(deleted === 1 ? 'Forgotten' : `${deleted} forgotten`, 'success');
            setConfirmBulk(false);
            clearSelection();
            invalidate();
        },
        onError: (error) =>
            toast(error instanceof Error ? error.message : 'Could not forget those', 'error'),
    });

    const clearAll = useMutation({
        mutationFn: () => clearAllMemories(),
        onSuccess: () => {
            toast('Everything forgotten', 'success');
            setConfirmClear(false);
            clearSelection();
            invalidate();
        },
        onError: (error) =>
            toast(error instanceof Error ? error.message : 'Could not clear memory', 'error'),
    });

    const selecting = selected.size > 0;

    const toggleSelected = (id: string): void =>
        setSelected((prev) => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });

    const typeChips = useMemo(() => {
        const counts = countsByType(stats.data);
        const known = MEMORY_TYPES.filter((id) => (counts[id] ?? 0) > 0).map((id) => ({
            id,
            label: memoryTypeLabel(id),
            count: counts[id] ?? 0,
        }));
        // A type this build does not know about — the import extractor and the
        // routine bookkeeping both write ids outside the seven — still needs a
        // way to be found and deleted.
        const extra = Object.keys(counts)
            .filter((id) => !MEMORY_TYPES.includes(id))
            .map((id) => ({ id, label: memoryTypeLabel(id), count: counts[id] ?? 0 }));
        return [...known, ...extra];
    }, [stats.data]);

    return (
        <Screen edges={['top', 'bottom']}>
            {/*
              * Two headers, because selection mode IS a different mode: the
              * back button becomes a cancel, the title becomes a count, and the
              * destructive action changes meaning. `showBack={false}` with an
              * explicit leading is how a screen says "this bar is not a place
              * you navigate back from".
              */}
            {selecting ? (
                <ScreenHeader
                    size="large"
                    showBack={false}
                    global={false}
                    leading={
                        <IconButton
                            icon={<Feather name="x" size={20} color={theme.colors.textPrimary} />}
                            accessibilityLabel="Cancel selection"
                            onPress={clearSelection}
                        />
                    }
                    title={`${selected.size} selected`}
                    actions={
                        <IconButton
                            icon={<Feather name="trash-2" size={20} color={theme.colors.error} />}
                            accessibilityLabel={`Forget ${selected.size} selected`}
                            tone="destructive"
                            onPress={() => setConfirmBulk(true)}
                        />
                    }
                />
            ) : (
                <ScreenHeader
                    title="Memory"
                    subtitle={
                        total === 0
                            ? 'Nothing remembered yet'
                            : `${total} thing${total === 1 ? '' : 's'} remembered about you`
                    }
                    actions={
                        total > 0 ? (
                            <IconButton
                                icon={<Feather name="trash-2" size={20} color={theme.colors.error} />}
                                accessibilityLabel="Forget everything"
                                tone="destructive"
                                onPress={() => setConfirmClear(true)}
                            />
                        ) : null
                    }
                />
            )}

            <View style={{ paddingHorizontal: theme.spacing.lg, paddingBottom: theme.spacing.sm }}>
                <SearchField
                    value={search}
                    onChangeText={setSearch}
                    placeholder="Search what it remembers"
                />
            </View>

            {typeChips.length > 0 ? (
                <ScrollView
                    horizontal
                    showsHorizontalScrollIndicator={false}
                    contentContainerStyle={{
                        paddingHorizontal: theme.spacing.lg,
                        paddingBottom: theme.spacing.sm,
                        gap: theme.spacing.sm,
                    }}
                >
                    <Chip label="Everything" selected={type === null} onPress={() => setType(null)} />
                    {typeChips.map((chip) => (
                        <Chip
                            key={chip.id}
                            label={`${chip.label} (${chip.count})`}
                            selected={type === chip.id}
                            onPress={() => setType(type === chip.id ? null : chip.id)}
                        />
                    ))}
                </ScrollView>
            ) : null}

            {list.isLoading ? (
                <ListSkeleton />
            ) : list.isError ? (
                <ErrorState error={list.error} onRetry={() => void list.refetch()} />
            ) : memories.length === 0 ? (
                <EmptyState
                    icon="cpu"
                    title={filtered ? 'Nothing matches that' : 'Nothing remembered yet'}
                    message={
                        filtered
                            ? 'Try another word, or clear the filter.'
                            : 'Bee Flow writes things down as you chat — a preference, a project, how you like an answer — and reuses them later. Anything it stores will show up here, and you can delete it.'
                    }
                    actionLabel={filtered ? 'Clear the filter' : undefined}
                    onAction={
                        filtered
                            ? () => {
                                  setSearch('');
                                  setType(null);
                              }
                            : undefined
                    }
                />
            ) : (
                <FlatList
                    data={memories}
                    keyExtractor={(memory) => memory.id}
                    refreshControl={
                        <RefreshControl
                            refreshing={list.isRefetching && !list.isFetchingNextPage}
                            onRefresh={() => void list.refetch()}
                            tintColor={theme.colors.accentPrimary}
                            colors={[theme.colors.accentPrimary]}
                        />
                    }
                    contentContainerStyle={{ paddingBottom: theme.spacing.xxl }}
                    ListHeaderComponent={
                        filtered ? (
                            <Text
                                variant="caption"
                                tone="tertiary"
                                style={{
                                    paddingHorizontal: theme.spacing.lg,
                                    paddingBottom: theme.spacing.sm,
                                }}
                            >
                                {matchCount === 1 ? '1 match' : `${matchCount} matches`}
                            </Text>
                        ) : null
                    }
                    onEndReachedThreshold={0.4}
                    onEndReached={() => {
                        if (list.hasNextPage && !list.isFetchingNextPage) void list.fetchNextPage();
                    }}
                    ListFooterComponent={
                        list.isFetchingNextPage ? (
                            <View style={{ paddingVertical: theme.spacing.lg }}>
                                <Spinner />
                            </View>
                        ) : null
                    }
                    renderItem={({ item }) => (
                        <MemoryRow
                            memory={item}
                            expanded={expandedId === item.id}
                            selecting={selecting}
                            selected={selected.has(item.id)}
                            onPress={() =>
                                selecting
                                    ? toggleSelected(item.id)
                                    : setExpandedId(expandedId === item.id ? null : item.id)
                            }
                            onLongPress={() => toggleSelected(item.id)}
                            onDelete={() => setPendingDelete(item)}
                        />
                    )}
                />
            )}

            <ConfirmSheet
                visible={Boolean(pendingDelete)}
                title="Forget this?"
                message={
                    pendingDelete
                        ? `“${truncate(memoryLine(pendingDelete))}”\n\nIt is deleted from the server, and Bee Flow stops using it in new conversations. Answers it already gave keep whatever they were based on. This cannot be undone.`
                        : ''
                }
                confirmLabel="Forget it"
                busy={removeOne.isPending}
                onCancel={() => setPendingDelete(null)}
                onConfirm={() => pendingDelete && removeOne.mutate(pendingDelete.id)}
            />

            <ConfirmSheet
                visible={confirmBulk}
                title={selected.size === 1 ? 'Forget this one?' : `Forget these ${selected.size}?`}
                message="They are deleted from the server, and Bee Flow stops using them in new conversations. Answers it already gave keep whatever they were based on. This cannot be undone."
                confirmLabel={selected.size === 1 ? 'Forget it' : `Forget ${selected.size}`}
                busy={removeMany.isPending}
                onCancel={() => setConfirmBulk(false)}
                onConfirm={() => removeMany.mutate([...selected])}
            />

            <ConfirmSheet
                visible={confirmClear}
                title="Forget everything?"
                message={`All ${total} thing${total === 1 ? '' : 's'} Bee Flow remembers about you ${total === 1 ? 'is' : 'are'} deleted from the server — preferences, people, projects, standing instructions, the lot. Your conversations, notebooks and files are untouched, and so is anything shared with a project team. Bee Flow starts over knowing nothing about you. This cannot be undone.`}
                confirmLabel="Forget everything"
                busy={clearAll.isPending}
                onCancel={() => setConfirmClear(false)}
                onConfirm={() => clearAll.mutate()}
            />
        </Screen>
    );
}

/** Enough of the sentence to recognise it, without a wall of text in a sheet. */
function truncate(text: string, max = 160): string {
    const flat = text.replace(/\s+/g, ' ').trim();
    return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
