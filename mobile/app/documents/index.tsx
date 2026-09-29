/**
 * Documents.
 *
 * There is no single "documents" table on this server, and pretending there is
 * would be the wrong shape. Two genuinely different things are gathered here,
 * and the tabs say which is which:
 *
 *   Indexed   — rows in `documents`, always owned by a knowledge base. These
 *               are the ones you upload, search, preview and delete. There is
 *               no cross-base endpoint, so the list is assembled by fanning out
 *               over the bases you can reach (see listDocumentsAcrossBases) —
 *               bounded, and tolerant of one base failing.
 *   Generated — PDFs the document-renderer produced, listed by
 *               /api/documents/list. They live in the server's temp directory
 *               and expire; there is no delete endpoint and no upload, so this
 *               tab offers exactly what exists: open and share.
 *
 * Uploading needs a destination, because ingestion is per knowledge base. When
 * the list is filtered to one base that IS the destination; when it is not,
 * the destination is asked for before the picker opens rather than guessed.
 */

import { Feather } from '@expo/vector-icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Stack, useRouter, useLocalSearchParams } from 'expo-router';
import React, { useCallback, useMemo, useState } from 'react';
import { FlatList, RefreshControl, View } from 'react-native';

import {
    deleteKbDocument,
    getKbDocumentChunks,
    ingestKbText,
    ingestKbUrl,
    libraryKeys,
    listDocumentsAcrossBases,
    listKnowledgeBases,
    listRenderedDocuments,
    type OwnedDocument,
} from '../../src/features/library/api';
import { AddSourceBody } from '../../src/features/library/components/AddSourceSheet';
import { PreviewSheet } from '../../src/features/library/components/PreviewSheet';
import { ScanCamera } from '../../src/features/library/components/ScanCamera';
import { UploadQueue } from '../../src/features/library/components/UploadQueue';
import { documentIcon } from '../../src/features/library/format';
import { shareServerFile, shareText } from '../../src/features/library/share';
import type { RenderedDocument } from '../../src/features/library/types';
import { kbIngestTarget } from '../../src/features/library/upload';
import { useUploadQueue } from '../../src/features/library/useUploadQueue';
import { formatBytes } from '../../src/lib/bytes';
import { relativeTime } from '../../src/lib/time';
import { useTheme } from '../../src/theme/ThemeProvider';
import { Badge, Chip } from '../../src/ui/Badge';
import { IconButton } from '../../src/ui/Button';
import { EmptyState, ErrorState, ListSkeleton, describeError } from '../../src/ui/Feedback';
import { SearchField } from '../../src/ui/Input';
import { ListRow } from '../../src/ui/List';
import { Screen } from '../../src/ui/Screen';
import { ScreenHeader } from '../../src/ui/ScreenHeader';
import { ConfirmSheet, Sheet } from '../../src/ui/Sheet';
import { Divider } from '../../src/ui/Surface';
import { Text } from '../../src/ui/Text';
import { useToast } from '../../src/ui/Toast';

type Tab = 'indexed' | 'generated';

export default function DocumentsScreen() {
    const theme = useTheme();
    const router = useRouter();
    const queryClient = useQueryClient();
    const { toast } = useToast();

    const [tab, setTab] = useState<Tab>('indexed');
    const [search, setSearch] = useState('');
    const [filterKbId, setFilterKbId] = useState<string | null>(null);
    /**
     * Where the next upload goes. Kept apart from the list filter because the
     * queue resolves its target at upload time — changing the filter mid-queue
     * must not redirect a file that is already in flight.
     */
    const [destinationKbId, setDestinationKbId] = useState<string | null>(null);
    const [pickingDestination, setPickingDestination] = useState(false);
    const [addOpen, setAddOpen] = useState(false);
    const [scanOpen, setScanOpen] = useState(false);
    const [previewOf, setPreviewOf] = useState<OwnedDocument | null>(null);
    /*
     * `?open=<id>` — set when a row somewhere else names a specific document.
     * Library's own document rows used to push `/documents` with no id, so
     * tapping a named document opened the LIST of documents: a shallow-looking
     * door that was a dead end.
     *
     * DERIVED, not set from an effect. Opening the sheet in a `useEffect` is a
     * setState-in-effect cascade the React Compiler rejects, and it would also
     * race the list's own loading. `dismissedAuto` is what lets the person
     * close a sheet the URL still asks for.
     */
    const { open: openId } = useLocalSearchParams<{ open?: string }>();
    const [dismissedAuto, setDismissedAuto] = useState(false);
    const [openingFile, setOpeningFile] = useState<RenderedDocument | null>(null);
    const [busyOpening, setBusyOpening] = useState(false);
    const [pendingDelete, setPendingDelete] = useState<OwnedDocument | null>(null);

    const bases = useQuery({
        queryKey: libraryKeys.knowledgeBases,
        queryFn: ({ signal }) => listKnowledgeBases(signal),
    });

    const scopedBases = useMemo(() => {
        const all = bases.data ?? [];
        return filterKbId ? all.filter((kb) => kb.id === filterKbId) : all;
    }, [bases.data, filterKbId]);

    const indexed = useQuery({
        queryKey: libraryKeys.documentsAcross(
            'all',
            scopedBases.map((kb) => kb.id).join(','),
        ),
        queryFn: ({ signal }) => listDocumentsAcrossBases(scopedBases, {}, signal),
        enabled: bases.isSuccess,
    });

    /**
     * The document this screen was asked to open, if the list holding it has
     * arrived and the person has not closed it. Pure derivation — see the note
     * on `openId` above.
     */
    const autoOpen =
        !dismissedAuto && openId
            ? (indexed.data?.documents.find((d) => d.id === openId) ?? null)
            : null;
    const preview = previewOf ?? autoOpen;

    const generated = useQuery({
        queryKey: libraryKeys.renderedDocuments,
        queryFn: ({ signal }) => listRenderedDocuments(signal),
        enabled: tab === 'generated',
    });

    const refreshIndexed = useCallback(() => {
        void queryClient.invalidateQueries({ queryKey: ['library', 'documents'] });
        void queryClient.invalidateQueries({ queryKey: libraryKeys.knowledgeBases });
    }, [queryClient]);

    const uploads = useUploadQueue(kbIngestTarget(destinationKbId ?? ''), {
        onUploaded: refreshIndexed,
    });

    const addUrl = useMutation({
        mutationFn: (url: string) => ingestKbUrl(destinationKbId ?? '', url),
        onSuccess: () => {
            setAddOpen(false);
            toast('Page added', 'success');
            refreshIndexed();
        },
    });

    const addText = useMutation({
        mutationFn: (input: { text: string; name: string }) =>
            ingestKbText(destinationKbId ?? '', input.text, input.name),
        onSuccess: () => {
            setAddOpen(false);
            toast('Added', 'success');
            refreshIndexed();
        },
    });

    const remove = useMutation({
        mutationFn: (doc: OwnedDocument) => deleteKbDocument(doc.kbId, doc.id),
        onSuccess: () => {
            setPendingDelete(null);
            toast('Document deleted', 'success');
            refreshIndexed();
        },
    });

    const chunks = useQuery({
        queryKey: libraryKeys.kbChunks(preview?.kbId ?? '', preview?.id ?? ''),
        queryFn: ({ signal }) =>
            getKbDocumentChunks(preview?.kbId ?? '', preview?.id ?? '', signal),
        enabled: Boolean(preview),
    });

    const previewText = useMemo(
        () => (chunks.data?.chunks ?? []).map((c) => c.content).join('\n\n'),
        [chunks.data],
    );

    const documents = useMemo(() => {
        const all = indexed.data?.documents ?? [];
        const needle = search.trim().toLowerCase();
        if (!needle) return all;
        return all.filter(
            (doc) =>
                (doc.title ?? '').toLowerCase().includes(needle) ||
                (doc.source_uri ?? '').toLowerCase().includes(needle) ||
                doc.kbName.toLowerCase().includes(needle),
        );
    }, [indexed.data, search]);

    const generatedDocuments = useMemo(() => {
        const all = generated.data ?? [];
        const needle = search.trim().toLowerCase();
        if (!needle) return all;
        return all.filter((doc) => doc.name.toLowerCase().includes(needle));
    }, [generated.data, search]);

    /** Start the add flow, asking where to put it if that is not yet settled. */
    const startAdd = useCallback(() => {
        const target = filterKbId ?? destinationKbId;
        if (target) {
            setDestinationKbId(target);
            setAddOpen(true);
            return;
        }
        setPickingDestination(true);
    }, [filterKbId, destinationKbId]);

    const openGenerated = useCallback(
        async (doc: RenderedDocument) => {
            setBusyOpening(true);
            try {
                // The bytes are fetched through the session cookie and handed to
                // the OS. Never a bare Linking call — an external viewer has a
                // different cookie jar and would be bounced to the login page.
                await shareServerFile(doc.viewUrl, doc.name, 'application/pdf');
            } catch (err) {
                toast(describeError(err).message, 'error');
            } finally {
                setBusyOpening(false);
            }
        },
        [toast],
    );

    return (
        <Screen edges={['top', 'bottom']}>
            <Stack.Screen options={{ headerShown: false }} />

            <ScreenHeader
                title="Documents"
                actions={
                    <>
                        {tab === 'indexed' ? (
                            <IconButton
                                icon={<Feather name="plus" size={20} color={theme.colors.textPrimary} />}
                                accessibilityLabel="Add a document"
                                onPress={startAdd}
                            />
                        ) : null}
                    </>
                }
            />

            <View
                style={{
                    flexDirection: 'row',
                    gap: theme.spacing.sm,
                    paddingHorizontal: theme.spacing.lg,
                    paddingBottom: theme.spacing.md,
                }}
            >
                <Chip label="Indexed" selected={tab === 'indexed'} onPress={() => setTab('indexed')} />
                <Chip
                    label="Generated"
                    selected={tab === 'generated'}
                    onPress={() => setTab('generated')}
                />
            </View>

            <View style={{ paddingHorizontal: theme.spacing.lg, paddingBottom: theme.spacing.sm }}>
                <SearchField value={search} onChangeText={setSearch} placeholder="Search documents" />
            </View>

            {tab === 'indexed' ? (
                <>
                    {(bases.data?.length ?? 0) > 1 ? (
                        <FlatList
                            horizontal
                            data={[null, ...(bases.data ?? [])]}
                            keyExtractor={(kb, i) => kb?.id ?? `all-${i}`}
                            showsHorizontalScrollIndicator={false}
                            style={{ flexGrow: 0 }}
                            contentContainerStyle={{
                                paddingHorizontal: theme.spacing.lg,
                                gap: theme.spacing.sm,
                                paddingBottom: theme.spacing.md,
                            }}
                            renderItem={({ item }) => (
                                <Chip
                                    label={item?.name ?? 'All'}
                                    selected={item ? filterKbId === item.id : filterKbId === null}
                                    onPress={() => setFilterKbId(item?.id ?? null)}
                                />
                            )}
                        />
                    ) : null}

                    {bases.isLoading || indexed.isLoading ? (
                        <ListSkeleton />
                    ) : bases.isError ? (
                        <ErrorState error={bases.error} onRetry={() => void bases.refetch()} />
                    ) : indexed.isError ? (
                        <ErrorState error={indexed.error} onRetry={() => void indexed.refetch()} />
                    ) : (
                        <FlatList
                            data={documents}
                            keyExtractor={(doc) => `${doc.kbId}-${doc.id}`}
                            refreshControl={
                                <RefreshControl
                                    refreshing={indexed.isRefetching}
                                    onRefresh={() => void indexed.refetch()}
                                    tintColor={theme.colors.accentPrimary}
                                    colors={[theme.colors.accentPrimary]}
                                />
                            }
                            ListHeaderComponent={
                                <View style={{ paddingHorizontal: theme.spacing.lg, gap: theme.spacing.md }}>
                                    {uploads.items.length > 0 ? (
                                        <UploadQueue
                                            items={uploads.items}
                                            onRetry={uploads.retry}
                                            onRemove={uploads.remove}
                                            onClearFinished={uploads.clearFinished}
                                        />
                                    ) : null}
                                    {(indexed.data?.skipped ?? 0) > 0 ? (
                                        <Text variant="label" tone="tertiary">
                                            Showing documents from your {scopedBases.length} most recent
                                            knowledge bases. Open a specific one to see the rest.
                                        </Text>
                                    ) : null}
                                </View>
                            }
                            ListEmptyComponent={
                                uploads.active ? null : (
                                    <EmptyState
                                        icon="file-text"
                                        title={search ? 'Nothing matches that' : 'No documents yet'}
                                        message={
                                            search
                                                ? 'Try a different word.'
                                                : 'Upload a file or scan a page into a knowledge base and it becomes searchable everywhere.'
                                        }
                                        actionLabel={search ? undefined : 'Add a document'}
                                        onAction={search ? undefined : startAdd}
                                    />
                                )
                            }
                            contentContainerStyle={{ paddingVertical: theme.spacing.md, paddingBottom: 96 }}
                            renderItem={({ item }) => (
                                <ListRow
                                    title={item.title || 'Untitled document'}
                                    subtitle={item.kbName}
                                    meta={relativeTime(item.created_at)}
                                    wrapTitle
                                    leading={
                                        <Feather
                                            name={documentIcon(item.source_type)}
                                            size={18}
                                            color={theme.colors.textMuted}
                                        />
                                    }
                                    trailing={
                                        item.chunk_count > 0 ? (
                                            <Badge label={`${item.chunk_count}`} />
                                        ) : (
                                            <Badge label="Not indexed" tone="warning" />
                                        )
                                    }
                                    onPress={() => setPreviewOf(item)}
                                    onLongPress={() => setPendingDelete(item)}
                                />
                            )}
                        />
                    )}
                </>
            ) : generated.isLoading ? (
                <ListSkeleton />
            ) : generated.isError ? (
                <ErrorState error={generated.error} onRetry={() => void generated.refetch()} />
            ) : (
                <FlatList
                    data={generatedDocuments}
                    keyExtractor={(doc) => doc.id}
                    refreshControl={
                        <RefreshControl
                            refreshing={generated.isRefetching}
                            onRefresh={() => void generated.refetch()}
                            tintColor={theme.colors.accentPrimary}
                            colors={[theme.colors.accentPrimary]}
                        />
                    }
                    ListHeaderComponent={
                        <Text
                            variant="label"
                            tone="tertiary"
                            style={{ paddingHorizontal: theme.spacing.lg, paddingBottom: theme.spacing.sm }}
                        >
                            PDFs Bee Flow rendered for you. They are temporary — download anything you
                            want to keep.
                        </Text>
                    }
                    ListEmptyComponent={
                        <EmptyState
                            icon="printer"
                            title={search ? 'Nothing matches that' : 'Nothing rendered yet'}
                            message="When an agent or an automation produces a PDF, it shows up here until it expires."
                        />
                    }
                    contentContainerStyle={{ paddingBottom: 96 }}
                    renderItem={({ item }) => (
                        <ListRow
                            title={item.name}
                            subtitle={formatBytes(item.sizeBytes)}
                            meta={relativeTime(item.createdAt)}
                            wrapTitle
                            leading={<Feather name="file" size={18} color={theme.colors.textMuted} />}
                            onPress={() => setOpeningFile(item)}
                        />
                    )}
                />
            )}

            {/* Where should this go? Only asked when the answer is not already on screen. */}
            <Sheet
                visible={pickingDestination}
                onClose={() => setPickingDestination(false)}
                title="Add it to which knowledge base?"
                subtitle="Documents are indexed per knowledge base"
                scroll={false}
            >
                <View>
                    {(bases.data ?? []).map((kb, i) => (
                        <React.Fragment key={kb.id}>
                            {i > 0 ? <Divider inset={theme.spacing.lg} /> : null}
                            <ListRow
                                title={kb.name}
                                subtitle={kb.description || undefined}
                                leading={
                                    <Feather name="database" size={18} color={theme.colors.textMuted} />
                                }
                                onPress={() => {
                                    setDestinationKbId(kb.id);
                                    setPickingDestination(false);
                                    setAddOpen(true);
                                }}
                            />
                        </React.Fragment>
                    ))}
                    {(bases.data?.length ?? 0) === 0 ? (
                        <EmptyState
                            icon="database"
                            title="No knowledge bases yet"
                            message="Documents live inside a knowledge base, so there has to be one first."
                            actionLabel="Create one"
                            onAction={() => {
                                setPickingDestination(false);
                                router.push('/knowledge');
                            }}
                        />
                    ) : null}
                </View>
            </Sheet>

            <Sheet
                visible={addOpen}
                onClose={() => setAddOpen(false)}
                title="Add a document"
                subtitle={(bases.data ?? []).find((kb) => kb.id === destinationKbId)?.name}
                scroll={false}
            >
                <AddSourceBody
                    accepts="PDF, Word, Excel, CSV or text · up to 20 MB"
                    busy={addUrl.isPending || addText.isPending}
                    onFiles={(files) => {
                        setAddOpen(false);
                        uploads.add(files);
                    }}
                    onScan={() => {
                        setAddOpen(false);
                        setScanOpen(true);
                    }}
                    onUrl={(url) => addUrl.mutate(url)}
                    onText={(text, name) => addText.mutate({ text, name })}
                />
            </Sheet>

            <ScanCamera
                visible={scanOpen}
                onClose={() => setScanOpen(false)}
                onCapture={(files) => {
                    setScanOpen(false);
                    uploads.add(files);
                }}
            />

            <PreviewSheet
                visible={Boolean(preview)}
                onClose={() => {
                    setPreviewOf(null);
                    // Closes it for good even though `?open=` is still in the
                    // route — otherwise the sheet would reopen on every render.
                    setDismissedAuto(true);
                }}
                title={preview?.title || 'Document'}
                subtitle={
                    chunks.data?.remote_only
                        ? 'Indexed in the search service — the text is not readable from here'
                        : preview?.kbName
                }
                kind="text"
                content={previewText}
                loading={chunks.isLoading}
                error={chunks.isError ? chunks.error : undefined}
                onRetry={() => void chunks.refetch()}
                onShare={
                    previewText
                        ? () => {
                              void shareText(previewText, preview?.title || 'document');
                          }
                        : undefined
                }
            />

            <PreviewSheet
                visible={Boolean(openingFile)}
                onClose={() => setOpeningFile(null)}
                title={openingFile?.name ?? ''}
                subtitle={
                    openingFile
                        ? `${formatBytes(openingFile.sizeBytes)} · rendered ${relativeTime(openingFile.createdAt)}`
                        : undefined
                }
                kind="binary"
                busyAction={busyOpening}
                onOpenWith={() => {
                    if (openingFile) void openGenerated(openingFile);
                }}
            />

            <ConfirmSheet
                visible={Boolean(pendingDelete)}
                title={`Delete “${pendingDelete?.title ?? ''}”?`}
                message={`It is removed from ${pendingDelete?.kbName ?? 'its knowledge base'}, along with everything indexed from it.`}
                confirmLabel="Delete document"
                busy={remove.isPending}
                onCancel={() => setPendingDelete(null)}
                onConfirm={() => pendingDelete && remove.mutate(pendingDelete)}
            />
        </Screen>
    );
}
