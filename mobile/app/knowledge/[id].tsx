/**
 * One knowledge base.
 *
 * Its documents, what is in them, and whether retrieval actually finds the
 * thing you expect. That last one is the point of the Query button: a
 * knowledge base is only as good as what comes back out of it, and the
 * difference between "the document is in there" and "the document is
 * findable" is invisible from a list of file names.
 *
 * Previewing a document means reading its CHUNKS, because that is all the
 * server keeps — the original bytes are not stored by the ingest route, only
 * the extracted text split for embedding. When those chunks live in the remote
 * search-service rather than the local table the route says so
 * (`remote_only`), and the sheet repeats it instead of showing an empty page
 * that looks like data loss.
 */

import { Feather } from '@expo/vector-icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import React, { useCallback, useMemo, useState } from 'react';
import { FlatList, RefreshControl, View } from 'react-native';

import {
    deleteKbDocument,
    getKbDocumentChunks,
    getKnowledgeBase,
    ingestKbText,
    ingestKbUrl,
    libraryKeys,
    listKbDocuments,
} from '../../src/features/library/api';
import { AddSourceBody } from '../../src/features/library/components/AddSourceSheet';
import { KbQuerySheet } from '../../src/features/library/components/KbQuerySheet';
import { PreviewSheet } from '../../src/features/library/components/PreviewSheet';
import { ScanCamera } from '../../src/features/library/components/ScanCamera';
import { UploadQueue } from '../../src/features/library/components/UploadQueue';
import { countLabel, documentIcon } from '../../src/features/library/format';
import { shareText } from '../../src/features/library/share';
import type { KbDocument } from '../../src/features/library/types';
import { kbIngestTarget } from '../../src/features/library/upload';
import { useUploadQueue } from '../../src/features/library/useUploadQueue';
import { plural } from '../../src/lib/format';
import { relativeTime } from '../../src/lib/time';
import { useTheme } from '../../src/theme/ThemeProvider';
import { Badge } from '../../src/ui/Badge';
import { Button, IconButton } from '../../src/ui/Button';
import { Banner, EmptyState, ErrorState, ListSkeleton } from '../../src/ui/Feedback';
import { ListRow } from '../../src/ui/List';
import { Screen } from '../../src/ui/Screen';
import { ScreenHeader } from '../../src/ui/ScreenHeader';
import { ConfirmSheet, Sheet } from '../../src/ui/Sheet';
import { useToast } from '../../src/ui/Toast';

export default function KnowledgeBaseScreen() {
    const { id } = useLocalSearchParams<{ id: string }>();
    const kbId = id ?? '';
    const theme = useTheme();
    const router = useRouter();
    const queryClient = useQueryClient();
    const { toast } = useToast();

    const [addOpen, setAddOpen] = useState(false);
    const [scanOpen, setScanOpen] = useState(false);
    const [queryOpen, setQueryOpen] = useState(false);
    const [previewOf, setPreviewOf] = useState<KbDocument | null>(null);
    const [pendingDelete, setPendingDelete] = useState<KbDocument | null>(null);

    const base = useQuery({
        queryKey: libraryKeys.knowledgeBase(kbId),
        queryFn: ({ signal }) => getKnowledgeBase(kbId, signal),
        enabled: Boolean(kbId),
    });

    // A separate read from the base: the detail response embeds an unpaged
    // document list, and this one is the paged endpoint the list actually
    // needs once a base grows past a screenful.
    const documents = useQuery({
        queryKey: libraryKeys.kbDocuments(kbId),
        queryFn: ({ signal }) => listKbDocuments(kbId, { limit: 200 }, signal),
        enabled: Boolean(kbId),
    });

    const refreshDocuments = useCallback(() => {
        void queryClient.invalidateQueries({ queryKey: libraryKeys.kbDocuments(kbId) });
        void queryClient.invalidateQueries({ queryKey: libraryKeys.knowledgeBase(kbId) });
        // The hub and the cross-KB document list are now stale too.
        void queryClient.invalidateQueries({ queryKey: ['library', 'documents'] });
        void queryClient.invalidateQueries({ queryKey: libraryKeys.knowledgeBases });
    }, [queryClient, kbId]);

    const uploads = useUploadQueue(kbIngestTarget(kbId), { onUploaded: refreshDocuments });

    const addUrl = useMutation({
        mutationFn: (url: string) => ingestKbUrl(kbId, url),
        onSuccess: () => {
            setAddOpen(false);
            toast('Page added', 'success');
            refreshDocuments();
        },
    });

    const addText = useMutation({
        mutationFn: (input: { text: string; name: string }) =>
            ingestKbText(kbId, input.text, input.name),
        onSuccess: () => {
            setAddOpen(false);
            toast('Added', 'success');
            refreshDocuments();
        },
    });

    const remove = useMutation({
        mutationFn: (docId: string) => deleteKbDocument(kbId, docId),
        onSuccess: () => {
            setPendingDelete(null);
            toast('Document deleted', 'success');
            refreshDocuments();
        },
    });

    const chunks = useQuery({
        queryKey: libraryKeys.kbChunks(kbId, previewOf?.id ?? ''),
        queryFn: ({ signal }) => getKbDocumentChunks(kbId, previewOf?.id ?? '', signal),
        enabled: Boolean(previewOf),
    });

    /**
     * Chunks overlap by design, but they are stored in order, so joining them
     * reads as the document did. This is a faithful view of what was indexed —
     * which is the thing worth checking — not of the original file.
     */
    const previewText = useMemo(() => {
        const rows = chunks.data?.chunks ?? [];
        return rows.map((c) => c.content).join('\n\n');
    }, [chunks.data]);

    const docs = documents.data?.documents ?? [];
    const kb = base.data;

    return (
        <Screen edges={['top', 'bottom']}>
            <Stack.Screen options={{ headerShown: false }} />

            <ScreenHeader
                title={kb?.name ?? 'Knowledge base'}
                subtitle={countLabel([ plural(documents.data?.total ?? docs.length, 'document'), Number(kb?.total_chunks ?? 0) > 0 ? `${Number(kb?.total_chunks)} chunks` : null, ])}
                actions={
                    <>
                        {/*
                          * The primary verb. Until this existed you could put a
                          * contract in here and have no way anywhere in the app to ask
                          * what its notice period was — `knowledgeBaseIds` was declared
                          * on the chat payload and never assigned, while the server
                          * ran access-validated retrieval on it the whole time.
                          *
                          * The magnifying glass below stays, demoted to what it is
                          * actually good at: showing the passages a question matches.
                          * It deliberately does not answer in prose (see KbQuerySheet),
                          * which is right for CHECKING retrieval and wrong as the only
                          * way to USE it.
                          */}
                        <Button
                            label="Ask"
                            onPress={() => router.push(`/chat/new?kb=${encodeURIComponent(kbId)}`)}
                            accessibilityHint="Starts a chat that can read this knowledge base"
                        />
                        <IconButton
                            icon={<Feather name="search" size={20} color={theme.colors.textPrimary} />}
                            accessibilityLabel="Show matching passages"
                            onPress={() => setQueryOpen(true)}
                        />
                        <IconButton
                            icon={<Feather name="plus" size={20} color={theme.colors.textPrimary} />}
                            accessibilityLabel="Add a document"
                            onPress={() => setAddOpen(true)}
                        />
                    </>
                }
            />

            {documents.isLoading ? (
                <ListSkeleton />
            ) : documents.isError ? (
                <ErrorState error={documents.error} onRetry={() => void documents.refetch()} />
            ) : (
                <FlatList
                    data={docs}
                    keyExtractor={(doc) => doc.id}
                    refreshControl={
                        <RefreshControl
                            refreshing={documents.isRefetching}
                            onRefresh={() => void documents.refetch()}
                            tintColor={theme.colors.accentPrimary}
                            colors={[theme.colors.accentPrimary]}
                        />
                    }
                    ListHeaderComponent={
                        <View style={{ paddingHorizontal: theme.spacing.lg, gap: theme.spacing.md }}>
                            {kb?.source_kind === 'system_managed' ? (
                                <Banner tone="info" icon="shield">
                                    This is a system knowledge base. It is kept up to date for you and
                                    cannot be edited here.
                                </Banner>
                            ) : null}
                            {uploads.items.length > 0 ? (
                                <UploadQueue
                                    items={uploads.items}
                                    onRetry={uploads.retry}
                                    onRemove={uploads.remove}
                                    onClearFinished={uploads.clearFinished}
                                />
                            ) : null}
                        </View>
                    }
                    ListEmptyComponent={
                        uploads.active ? null : (
                            <EmptyState
                                icon="file-plus"
                                title="No documents yet"
                                message="Upload a file, scan a page, or point it at a web address. Text is extracted and indexed on your server — then you can ask about it."
                                actionLabel="Add a document"
                                onAction={() => setAddOpen(true)}
                            />
                        )
                    }
                    contentContainerStyle={{ paddingVertical: theme.spacing.md, paddingBottom: 96 }}
                    renderItem={({ item }) => (
                        <ListRow
                            title={item.title || 'Untitled document'}
                            subtitle={item.source_uri || undefined}
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
                                    <Badge label={`${item.chunk_count} chunks`} />
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

            <Sheet
                visible={addOpen}
                onClose={() => setAddOpen(false)}
                title="Add a document"
                subtitle={kb?.name}
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
                baseName={kb?.name ? `${kb.name} scan` : 'Scan'}
                onCapture={(files) => {
                    setScanOpen(false);
                    uploads.add(files);
                }}
            />

            <KbQuerySheet
                visible={queryOpen}
                onClose={() => setQueryOpen(false)}
                kbId={kbId}
                kbName={kb?.name ?? 'This knowledge base'}
            />

            <PreviewSheet
                visible={Boolean(previewOf)}
                onClose={() => setPreviewOf(null)}
                title={previewOf?.title || 'Document'}
                subtitle={
                    chunks.data?.remote_only
                        ? 'Indexed in the search service — the text is not readable from here'
                        : 'The indexed text, in the order it was chunked'
                }
                kind="text"
                content={previewText}
                loading={chunks.isLoading}
                error={chunks.isError ? chunks.error : undefined}
                onRetry={() => void chunks.refetch()}
                onShare={
                    previewText
                        ? () => {
                              void shareText(previewText, previewOf?.title || 'document');
                          }
                        : undefined
                }
            />

            <ConfirmSheet
                visible={Boolean(pendingDelete)}
                title={`Delete “${pendingDelete?.title ?? ''}”?`}
                message="The document and its chunks are removed from this knowledge base, so agents will stop finding it."
                confirmLabel="Delete document"
                busy={remove.isPending}
                onCancel={() => setPendingDelete(null)}
                onConfirm={() => pendingDelete && remove.mutate(pendingDelete.id)}
            />

            {docs.length > 0 ? (
                <View
                    style={{
                        position: 'absolute',
                        right: theme.spacing.lg,
                        bottom: theme.spacing.xl,
                    }}
                >
                    <Button
                        label="Query"
                        onPress={() => setQueryOpen(true)}
                        icon={<Feather name="search" size={16} color={theme.colors.accentPrimaryFg} />}
                        style={theme.elevation.raised}
                    />
                </View>
            ) : null}
        </Screen>
    );
}
