/**
 * Library tab — everything you read.
 *
 * A hub rather than a list, because the four collections underneath it
 * (notebooks, knowledge bases, documents, templates) are genuinely different
 * things and a single merged feed of them would be unreadable. Each section
 * shows what changed most recently and hands off to its own screen.
 *
 * The search box on top is the exception: when you are looking for one
 * specific thing you do not know or care which collection it is in, so typing
 * collapses the whole hub into one ranked list of matches with their kind
 * shown as a badge. Notebooks are searched on the SERVER (the route whitelists
 * a `search` param and pages the result); the other three collections are
 * fully loaded for the hub anyway, so they are filtered here.
 *
 * Memory and house styles sit at the bottom as rows rather than sections. Both
 * are things you check occasionally and change rarely, and neither has enough
 * items to be worth a screen of its own on a phone.
 */

import { Feather } from '@expo/vector-icons';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import React, { useMemo, useState } from 'react';
import { FlatList, RefreshControl, ScrollView, View } from 'react-native';

import { useAuth } from '../../src/auth/AuthProvider';
import {
    isUnavailable,
    libraryKeys,
    listDocumentsAcrossBases,
    listKnowledgeBases,
    listNotebooks,
    listTemplates,
} from '../../src/features/library/api';
import { HouseStylesSheet } from '../../src/features/library/components/HouseStylesSheet';
import { HubSection } from '../../src/features/library/components/HubSection';
import { MemorySheet } from '../../src/features/library/components/MemorySheet';
import { countLabel, documentIcon } from '../../src/features/library/format';
import type { LibraryHit } from '../../src/features/library/types';
import { plural } from '../../src/lib/format';
import { relativeTime } from '../../src/lib/time';
import { useTheme } from '../../src/theme/ThemeProvider';
import { Badge } from '../../src/ui/Badge';
import { EmptyState } from '../../src/ui/Feedback';
import { SearchField } from '../../src/ui/Input';
import { ListRow } from '../../src/ui/List';
import { Screen } from '../../src/ui/Screen';
import { ScreenHeader } from '../../src/ui/ScreenHeader';
import { Divider } from '../../src/ui/Surface';
import { Text } from '../../src/ui/Text';

/** How many rows a hub section shows before "See all" earns its place. */
const PREVIEW_ROWS = 4;

export default function LibraryScreen() {
    const theme = useTheme();
    const router = useRouter();
    const queryClient = useQueryClient();
    const { user } = useAuth();

    const [search, setSearch] = useState('');
    const [memoryOpen, setMemoryOpen] = useState(false);
    const [houseStylesOpen, setHouseStylesOpen] = useState(false);

    const term = search.trim();

    const notebooks = useQuery({
        queryKey: libraryKeys.notebooks(term),
        queryFn: ({ signal }) => listNotebooks({ search: term, sort: 'activity', limit: 30 }, signal),
    });

    const bases = useQuery({
        queryKey: libraryKeys.knowledgeBases,
        queryFn: ({ signal }) => listKnowledgeBases(signal),
    });

    const templates = useQuery({
        queryKey: libraryKeys.templates,
        queryFn: ({ signal }) => listTemplates(signal),
        // The whole router is behind a beta flag; a 403 is an answer, not a
        // transient fault, and retrying it three times helps nobody.
        retry: false,
    });

    // Documents have no cross-KB endpoint, so the hub fans out over the few
    // most recent knowledge bases only. The full screen widens the net.
    const baseIds = (bases.data ?? []).map((kb) => kb.id).join(',');
    const documents = useQuery({
        queryKey: libraryKeys.documentsAcross('hub', baseIds),
        queryFn: ({ signal }) =>
            listDocumentsAcrossBases(bases.data ?? [], { maxBases: 4, perBase: 10 }, signal),
        enabled: bases.isSuccess,
    });

    const refreshing =
        notebooks.isRefetching || bases.isRefetching || templates.isRefetching || documents.isRefetching;

    const refreshAll = () => {
        void queryClient.invalidateQueries({ queryKey: ['library'] });
    };

    const hits = useMemo<LibraryHit[]>(() => {
        if (!term) return [];
        const needle = term.toLowerCase();
        const matches = (...fields: (string | null | undefined)[]) =>
            fields.some((f) => (f ?? '').toLowerCase().includes(needle));

        return [
            // Already server-filtered — every row that came back is a match.
            ...(notebooks.data?.notebooks ?? []).map<LibraryHit>((nb) => ({
                kind: 'notebook',
                id: nb.id,
                title: nb.name,
                subtitle: nb.description || nb.preview || undefined,
                meta: relativeTime(nb.lastActivityAt ?? nb.updatedAt),
                href: `/notebooks/${nb.id}`,
            })),
            ...(bases.data ?? [])
                .filter((kb) => matches(kb.name, kb.description))
                .map<LibraryHit>((kb) => ({
                    kind: 'knowledge',
                    id: kb.id,
                    title: kb.name,
                    subtitle: kb.description || undefined,
                    meta: `${Number(kb.document_count ?? 0)} docs`,
                    href: `/knowledge/${kb.id}`,
                })),
            ...(documents.data?.documents ?? [])
                .filter((doc) => matches(doc.title, doc.source_uri))
                .map<LibraryHit>((doc) => ({
                    kind: 'document',
                    id: doc.id,
                    title: doc.title || 'Untitled document',
                    subtitle: doc.kbName,
                    meta: relativeTime(doc.created_at),
                    href: `/knowledge/${doc.kbId}`,
                })),
            ...(templates.data ?? [])
                .filter((t) => matches(t.name, t.description))
                .map<LibraryHit>((t) => ({
                    kind: 'template',
                    id: t.id,
                    title: t.name,
                    subtitle: t.description || undefined,
                    meta: plural(t.parameters.length, 'field'),
                    href: '/templates',
                })),
        ];
    }, [term, notebooks.data, bases.data, documents.data, templates.data]);

    return (
        <Screen edges={['top']}>
            <ScreenHeader size="large" title="Library" />

            <View style={{ paddingHorizontal: theme.spacing.lg, paddingBottom: theme.spacing.sm }}>
                <SearchField
                    value={search}
                    onChangeText={setSearch}
                    placeholder="Search your library"
                />
            </View>

            {term ? (
                <FlatList
                    data={hits}
                    keyExtractor={(hit) => `${hit.kind}-${hit.id}`}
                    keyboardShouldPersistTaps="handled"
                    refreshControl={
                        <RefreshControl
                            refreshing={refreshing}
                            onRefresh={refreshAll}
                            tintColor={theme.colors.accentPrimary}
                            colors={[theme.colors.accentPrimary]}
                        />
                    }
                    ListEmptyComponent={
                        <EmptyState
                            icon="search"
                            title="Nothing matches that"
                            message="Try fewer words. Search looks at names and descriptions, not inside documents — to search inside a knowledge base, open it and use Query."
                        />
                    }
                    contentContainerStyle={{ paddingBottom: 96 }}
                    renderItem={({ item }) => (
                        <ListRow
                            title={item.title}
                            subtitle={item.subtitle}
                            meta={item.meta}
                            wrapTitle
                            leading={
                                <Feather
                                    name={KIND_ICON[item.kind]}
                                    size={18}
                                    color={theme.colors.textMuted}
                                />
                            }
                            trailing={<Badge label={KIND_LABEL[item.kind]} />}
                            onPress={() => router.push(item.href as never)}
                        />
                    )}
                />
            ) : (
                <ScrollView
                    contentContainerStyle={{ paddingBottom: 96, gap: theme.spacing.xl }}
                    refreshControl={
                        <RefreshControl
                            refreshing={refreshing}
                            onRefresh={refreshAll}
                            tintColor={theme.colors.accentPrimary}
                            colors={[theme.colors.accentPrimary]}
                        />
                    }
                >
                    <HubSection
                        title="Notebooks"
                        icon="book"
                        // Only a truthful count: the hub asks for one page, so
                        // showing its length when the server says there is more
                        // would understate what the person has.
                        count={
                            notebooks.data && !notebooks.data.hasMore
                                ? notebooks.data.notebooks.length
                                : undefined
                        }
                        onSeeAll={() => router.push('/notebooks')}
                        loading={notebooks.isLoading}
                        error={notebooks.isError ? notebooks.error : undefined}
                        onRetry={() => void notebooks.refetch()}
                        isEmpty={(notebooks.data?.notebooks.length ?? 0) === 0}
                        emptyTitle="No notebooks yet"
                        emptyMessage="A notebook gathers sources — files, links, meetings — and lets you ask questions across all of them."
                        emptyActionLabel="Create one"
                        onEmptyAction={() => router.push('/notebooks')}
                    >
                        {(notebooks.data?.notebooks ?? []).slice(0, PREVIEW_ROWS).map((nb, i) => (
                            <React.Fragment key={nb.id}>
                                {i > 0 ? <Divider inset={theme.spacing.lg} /> : null}
                                <ListRow
                                    title={nb.name}
                                    subtitle={
                                        countLabel([
                                            plural(nb.sourceCount, 'source'),
                                            nb.processingCount > 0 ? `${nb.processingCount} processing` : null,
                                            nb.messageCount > 0 ? plural(nb.messageCount, 'message') : null,
                                        ]) || undefined
                                    }
                                    meta={relativeTime(nb.lastActivityAt ?? nb.updatedAt)}
                                    leading={
                                        nb.pinned ? (
                                            <Feather
                                                name="bookmark"
                                                size={16}
                                                color={theme.colors.accentPrimary}
                                            />
                                        ) : (
                                            <Feather name="book" size={16} color={theme.colors.textMuted} />
                                        )
                                    }
                                    onPress={() => router.push(`/notebooks/${nb.id}`)}
                                />
                            </React.Fragment>
                        ))}
                    </HubSection>

                    <HubSection
                        title="Knowledge bases"
                        icon="database"
                        count={bases.data?.length}
                        onSeeAll={() => router.push('/knowledge')}
                        loading={bases.isLoading}
                        error={bases.isError ? bases.error : undefined}
                        onRetry={() => void bases.refetch()}
                        isEmpty={(bases.data?.length ?? 0) === 0}
                        emptyTitle="No knowledge bases"
                        emptyMessage="A knowledge base is the searchable memory your agents read from."
                        emptyActionLabel="Create one"
                        onEmptyAction={() => router.push('/knowledge')}
                    >
                        {(bases.data ?? []).slice(0, PREVIEW_ROWS).map((kb, i) => (
                            <React.Fragment key={kb.id}>
                                {i > 0 ? <Divider inset={theme.spacing.lg} /> : null}
                                <ListRow
                                    title={kb.name}
                                    subtitle={kb.description || undefined}
                                    meta={countLabel([
                                        plural(Number(kb.document_count ?? 0), 'doc'),
                                        Number(kb.total_chunks ?? 0) > 0
                                            ? `${Number(kb.total_chunks)} chunks`
                                            : null,
                                    ])}
                                    leading={
                                        <Feather name="database" size={16} color={theme.colors.textMuted} />
                                    }
                                    onPress={() => router.push(`/knowledge/${kb.id}`)}
                                />
                            </React.Fragment>
                        ))}
                    </HubSection>

                    <HubSection
                        title="Documents"
                        icon="file-text"
                        onSeeAll={() => router.push('/documents')}
                        loading={documents.isLoading || bases.isLoading}
                        error={documents.isError ? documents.error : undefined}
                        onRetry={() => void documents.refetch()}
                        isEmpty={(documents.data?.documents.length ?? 0) === 0}
                        emptyTitle="No documents yet"
                        emptyMessage="Upload a file or scan a page and it becomes searchable across your knowledge bases."
                        emptyActionLabel="Add a document"
                        onEmptyAction={() => router.push('/documents')}
                    >
                        {(documents.data?.documents ?? []).slice(0, PREVIEW_ROWS).map((doc, i) => (
                            <React.Fragment key={doc.id}>
                                {i > 0 ? <Divider inset={theme.spacing.lg} /> : null}
                                <ListRow
                                    title={doc.title || 'Untitled document'}
                                    subtitle={doc.kbName}
                                    meta={relativeTime(doc.created_at)}
                                    wrapTitle
                                    leading={
                                        <Feather
                                            name={documentIcon(doc.source_type)}
                                            size={16}
                                            color={theme.colors.textMuted}
                                        />
                                    }
                                    // The row names a document; it must open
                                    // THAT document. It used to push the list,
                                    // so the shallow-looking door was a dead
                                    // end and finding one document still cost
                                    // four taps.
                                    onPress={() => router.push(`/documents?open=${encodeURIComponent(doc.id)}`)}
                                />
                            </React.Fragment>
                        ))}
                    </HubSection>

                    <HubSection
                        title="Templates"
                        icon="layout"
                        count={templates.data?.length}
                        onSeeAll={() => router.push('/templates')}
                        loading={templates.isLoading}
                        // A 403 here is "templates are not switched on for this
                        // organisation", which the empty copy explains better
                        // than a red error with a dead retry button.
                        error={templates.isError && !isUnavailable(templates.error) ? templates.error : undefined}
                        onRetry={() => void templates.refetch()}
                        isEmpty={(templates.data?.length ?? 0) === 0 || isUnavailable(templates.error)}
                        emptyTitle={
                            isUnavailable(templates.error) ? 'Templates are not enabled' : 'No templates yet'
                        }
                        emptyMessage={
                            isUnavailable(templates.error)
                                ? 'Templates are a beta feature. An administrator can switch them on for your organisation.'
                                : 'Upload a Word document with {{placeholders}} and Bee Flow will fill it in for you.'
                        }
                        emptyActionLabel={isUnavailable(templates.error) ? undefined : 'Open templates'}
                        onEmptyAction={
                            isUnavailable(templates.error) ? undefined : () => router.push('/templates')
                        }
                    >
                        {(templates.data ?? []).slice(0, PREVIEW_ROWS).map((t, i) => (
                            <React.Fragment key={t.id}>
                                {i > 0 ? <Divider inset={theme.spacing.lg} /> : null}
                                <ListRow
                                    title={t.name}
                                    subtitle={t.description || t.fileName || undefined}
                                    meta={plural(t.parameters.length, 'field')}
                                    wrapTitle
                                    leading={
                                        <Feather name="layout" size={16} color={theme.colors.textMuted} />
                                    }
                                    onPress={() => router.push('/templates')}
                                />
                            </React.Fragment>
                        ))}
                    </HubSection>

                    <View style={{ gap: theme.spacing.sm }}>
                        <Text
                            variant="label"
                            tone="tertiary"
                            style={{ paddingHorizontal: theme.spacing.lg }}
                        >
                            ALSO HERE
                        </Text>
                        <View
                            style={{
                                marginHorizontal: theme.spacing.lg,
                                borderRadius: theme.radii.lg,
                                backgroundColor: theme.colors.bgCard,
                                overflow: 'hidden',
                            }}
                        >
                            <ListRow
                                title="Memory"
                                subtitle="What Bee Flow carries between conversations"
                                leading={<Feather name="cpu" size={18} color={theme.colors.textMuted} />}
                                onPress={() => setMemoryOpen(true)}
                            />
                            <Divider inset={theme.spacing.lg} />
                            <ListRow
                                title="House styles"
                                subtitle="The Word styling applied to notebook exports"
                                leading={<Feather name="type" size={18} color={theme.colors.textMuted} />}
                                onPress={() => setHouseStylesOpen(true)}
                            />
                        </View>
                    </View>
                </ScrollView>
            )}

            <MemorySheet visible={memoryOpen} onClose={() => setMemoryOpen(false)} />
            <HouseStylesSheet
                visible={houseStylesOpen}
                onClose={() => setHouseStylesOpen(false)}
                orgId={user?.organizationId ?? null}
            />
        </Screen>
    );
}

const KIND_ICON: Record<LibraryHit['kind'], keyof typeof Feather.glyphMap> = {
    notebook: 'book',
    knowledge: 'database',
    document: 'file-text',
    template: 'layout',
};

const KIND_LABEL: Record<LibraryHit['kind'], string> = {
    notebook: 'Notebook',
    knowledge: 'Knowledge',
    document: 'Document',
    template: 'Template',
};
