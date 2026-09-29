/**
 * Knowledge bases.
 *
 * The list endpoint already filters by what the caller may reach — personal
 * bases, published org bases that pass the group check, and any system base
 * their org's beta flags switch on — so there is nothing to hide here and
 * everything returned is openable.
 *
 * Two things are surfaced that the row itself does not obviously carry:
 * whether a base is a draft (unpublished, so colleagues cannot see it) and
 * whether it was created automatically by a notebook or a webpage rather than
 * by hand. Both change what a person expects to be able to do with it.
 *
 * "Query everything" is at the top rather than inside a base, because the
 * commonest question is "do we have anything about X at all", and the search
 * route answers exactly that when it is given no ids (BFSF-216).
 */

import { Feather } from '@expo/vector-icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Stack, useRouter } from 'expo-router';
import React, { useMemo, useState } from 'react';
import { FlatList, Pressable, RefreshControl, View } from 'react-native';

import {
    createKnowledgeBase,
    deleteKnowledgeBase,
    libraryKeys,
    listKnowledgeBases,
} from '../../src/features/library/api';
import { KbQuerySheet } from '../../src/features/library/components/KbQuerySheet';
import { countLabel } from '../../src/features/library/format';
import type { KnowledgeBase } from '../../src/features/library/types';
import { plural } from '../../src/lib/format';
import { useTheme } from '../../src/theme/ThemeProvider';
import { Badge } from '../../src/ui/Badge';
import { Button, IconButton } from '../../src/ui/Button';
import { EmptyState, ErrorState, ListSkeleton } from '../../src/ui/Feedback';
import { SearchField, TextField } from '../../src/ui/Input';
import { ListRow } from '../../src/ui/List';
import { Screen } from '../../src/ui/Screen';
import { ScreenHeader } from '../../src/ui/ScreenHeader';
import { ConfirmSheet, Sheet } from '../../src/ui/Sheet';
import { Text } from '../../src/ui/Text';
import { useToast } from '../../src/ui/Toast';

export default function KnowledgeListScreen() {
    const theme = useTheme();
    const router = useRouter();
    const queryClient = useQueryClient();
    const { toast } = useToast();

    const [search, setSearch] = useState('');
    const [creating, setCreating] = useState(false);
    const [name, setName] = useState('');
    const [description, setDescription] = useState('');
    const [queryOpen, setQueryOpen] = useState(false);
    const [pendingDelete, setPendingDelete] = useState<KnowledgeBase | null>(null);

    const query = useQuery({
        queryKey: libraryKeys.knowledgeBases,
        queryFn: ({ signal }) => listKnowledgeBases(signal),
    });

    const create = useMutation({
        mutationFn: () => createKnowledgeBase({ name: name.trim(), description: description.trim() }),
        onSuccess: (kb) => {
            setCreating(false);
            setName('');
            setDescription('');
            void queryClient.invalidateQueries({ queryKey: libraryKeys.knowledgeBases });
            if (kb?.id) router.push(`/knowledge/${kb.id}`);
        },
    });

    const remove = useMutation({
        mutationFn: (id: string) => deleteKnowledgeBase(id),
        onSuccess: () => {
            toast('Knowledge base deleted', 'success');
            setPendingDelete(null);
            void queryClient.invalidateQueries({ queryKey: libraryKeys.knowledgeBases });
        },
    });

    const bases = useMemo(() => {
        const all = query.data ?? [];
        const needle = search.trim().toLowerCase();
        if (!needle) return all;
        return all.filter(
            (kb) =>
                kb.name.toLowerCase().includes(needle) ||
                (kb.description ?? '').toLowerCase().includes(needle),
        );
    }, [query.data, search]);

    return (
        <Screen edges={['top', 'bottom']}>
            <Stack.Screen options={{ headerShown: false }} />

            <ScreenHeader
                title="Knowledge"
                actions={
                    <>
                        <IconButton
                            icon={<Feather name="search" size={20} color={theme.colors.textPrimary} />}
                            accessibilityLabel="Query every knowledge base"
                            onPress={() => setQueryOpen(true)}
                        />
                    </>
                }
            />

            <View style={{ paddingHorizontal: theme.spacing.lg, paddingBottom: theme.spacing.sm }}>
                <SearchField
                    value={search}
                    onChangeText={setSearch}
                    placeholder="Filter knowledge bases"
                />
            </View>

            {query.isLoading ? (
                <ListSkeleton />
            ) : query.isError ? (
                <ErrorState error={query.error} onRetry={() => void query.refetch()} />
            ) : bases.length === 0 ? (
                <EmptyState
                    icon="database"
                    title={search ? 'Nothing matches that' : 'No knowledge bases'}
                    message={
                        search
                            ? 'Try a different word.'
                            : 'A knowledge base holds documents your agents can search. Everything in it is indexed on your own server.'
                    }
                    actionLabel={search ? undefined : 'New knowledge base'}
                    onAction={search ? undefined : () => setCreating(true)}
                />
            ) : (
                <FlatList
                    data={bases}
                    keyExtractor={(kb) => kb.id}
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
                            subtitle={item.description || undefined}
                            meta={countLabel([
                                plural(Number(item.document_count ?? 0), 'doc'),
                                Number(item.total_chunks ?? 0) > 0
                                    ? `${Number(item.total_chunks)} chunks`
                                    : null,
                            ])}
                            wrapTitle
                            leading={
                                <Feather
                                    name={item.source_kind === 'system_managed' ? 'shield' : 'database'}
                                    size={18}
                                    color={theme.colors.textMuted}
                                />
                            }
                            trailing={
                                item.organization_id && !item.is_published ? (
                                    <Badge label="Draft" tone="warning" />
                                ) : item.source_kind && item.source_kind !== 'manual' ? (
                                    <Badge label={SOURCE_KIND_LABEL[item.source_kind] ?? 'Automatic'} />
                                ) : undefined
                            }
                            onPress={() => router.push(`/knowledge/${item.id}`)}
                            onLongPress={() => setPendingDelete(item)}
                        />
                    )}
                />
            )}

            <Pressable
                onPress={() => setCreating(true)}
                accessibilityRole="button"
                accessibilityLabel="New knowledge base"
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
                title="New knowledge base"
                subtitle="It starts empty — add documents next"
            >
                <TextField label="Name" value={name} onChangeText={setName} autoFocus placeholder="Policies" />
                <TextField
                    label="What is it for?"
                    value={description}
                    onChangeText={setDescription}
                    multiline
                    maxLines={4}
                    placeholder="Everything HR publishes internally."
                    hint="Agents read this to decide when to search here, so a plain sentence helps."
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
                    onPress={() => create.mutate()}
                />
            </Sheet>

            <KbQuerySheet
                visible={queryOpen}
                onClose={() => setQueryOpen(false)}
                kbName="Everything you can reach"
            />

            <ConfirmSheet
                visible={Boolean(pendingDelete)}
                title={`Delete “${pendingDelete?.name ?? ''}”?`}
                message="Its documents, chunks and embeddings are removed everywhere they were indexed. Agents that searched it will stop finding anything. This cannot be undone."
                confirmLabel="Delete knowledge base"
                busy={remove.isPending}
                onCancel={() => setPendingDelete(null)}
                onConfirm={() => pendingDelete && remove.mutate(pendingDelete.id)}
            />
        </Screen>
    );
}

/** `source_kind` on the row — set by whichever flow created the base. */
const SOURCE_KIND_LABEL: Record<string, string> = {
    notebook: 'From a notebook',
    webpage: 'From a webpage',
    system_managed: 'System',
};
