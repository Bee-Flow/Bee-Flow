/**
 * One notebook.
 *
 * Two halves, switched rather than stacked: the sources it is built from, and
 * the conversation you have with them. On a phone there is no room to show
 * both, and they are used at different moments — you assemble sources once and
 * then ask questions for a week.
 *
 * The sources half is where ingestion is made visible. Adding a source returns
 * 200 immediately and the extraction, chunking and embedding happen on a
 * worker (routes/notebooks.js), so the list polls while anything is in flight
 * and every row says which stage it is at. A notebook whose sources are still
 * processing will answer badly, so the chat half says so rather than letting
 * the model shrug.
 *
 * The chat half streams from /ai/chat/notebook/stream. Three of its events
 * have no equivalent in direct chat and are handled here: a document rewrite,
 * a source added by a research tool mid-answer, and a locked (undecryptable)
 * history — see useLibraryChatStream.ts.
 */

import { Feather } from '@expo/vector-icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Stack, useLocalSearchParams } from 'expo-router';
import React, { useCallback, useMemo, useState } from 'react';
import { FlatList, RefreshControl, StyleSheet, View } from 'react-native';

import type { ChatMessage } from '../../src/features/chat/types';
import {
    deleteSource as deleteSourceRequest,
    addTextSource,
    addUrlSource,
    cancelSource,
    getNotebook,
    getNotebookConversation,
    getSourceContent,
    libraryKeys,
    retrySource,
    updateNotebook,
} from '../../src/features/library/api';
import { AddSourceBody } from '../../src/features/library/components/AddSourceSheet';
import { LibraryChat } from '../../src/features/library/components/LibraryChat';
import { PreviewSheet } from '../../src/features/library/components/PreviewSheet';
import { ScanCamera } from '../../src/features/library/components/ScanCamera';
import { SourceRow, SourceSummary } from '../../src/features/library/components/SourceRow';
import { UploadQueue } from '../../src/features/library/components/UploadQueue';
import { shareText } from '../../src/features/library/share';
import type { NotebookSource } from '../../src/features/library/types';
import { notebookSourceTarget } from '../../src/features/library/upload';
import { useUploadQueue } from '../../src/features/library/useUploadQueue';
import { plural } from '../../src/lib/format';
import { useTheme } from '../../src/theme/ThemeProvider';
import { Chip } from '../../src/ui/Badge';
import { Button, IconButton } from '../../src/ui/Button';
import { Banner, EmptyState, ErrorState, ListSkeleton } from '../../src/ui/Feedback';
import { Screen } from '../../src/ui/Screen';
import { ScreenHeader } from '../../src/ui/ScreenHeader';
import { ConfirmSheet, Sheet } from '../../src/ui/Sheet';
import { useToast } from '../../src/ui/Toast';

/** How often to re-read while a source is still being ingested. */
const INGEST_POLL_MS = 4000;

function isWorking(source: NotebookSource): boolean {
    return source.status === 'processing' || source.status === 'pending';
}

export default function NotebookScreen() {
    const { id } = useLocalSearchParams<{ id: string }>();
    const notebookId = id ?? '';
    const theme = useTheme();
    const queryClient = useQueryClient();
    const { toast } = useToast();

    const [tab, setTab] = useState<'sources' | 'chat'>('sources');
    const [addOpen, setAddOpen] = useState(false);
    const [scanOpen, setScanOpen] = useState(false);
    const [previewOf, setPreviewOf] = useState<NotebookSource | null>(null);
    const [pendingDelete, setPendingDelete] = useState<NotebookSource | null>(null);
    const [pinnedOverride, setPinnedOverride] = useState<boolean | null>(null);

    const query = useQuery({
        queryKey: libraryKeys.notebook(notebookId),
        queryFn: ({ signal }) => getNotebook(notebookId, signal),
        enabled: Boolean(notebookId),
        // Poll only while something is actually being ingested. A notebook at
        // rest must not keep a phone's radio awake.
        refetchInterval: (q) =>
            q.state.data?.sources.some(isWorking) ? INGEST_POLL_MS : false,
    });

    const notebook = query.data?.notebook ?? null;
    const sources = useMemo(() => query.data?.sources ?? [], [query.data]);

    const refreshSources = useCallback(() => {
        void queryClient.invalidateQueries({ queryKey: libraryKeys.notebook(notebookId) });
    }, [queryClient, notebookId]);

    const uploads = useUploadQueue(notebookSourceTarget(notebookId), {
        // The route answers with the source row before ingestion starts, so
        // the new row appears immediately and then polls to `ready`.
        onUploaded: refreshSources,
    });

    const addUrl = useMutation({
        mutationFn: (url: string) => addUrlSource(notebookId, url),
        onSuccess: () => {
            setAddOpen(false);
            toast('Fetching that page…', 'success');
            refreshSources();
        },
    });

    const addText = useMutation({
        mutationFn: (input: { text: string; name: string }) =>
            addTextSource(notebookId, input.text, input.name),
        onSuccess: () => {
            setAddOpen(false);
            toast('Added', 'success');
            refreshSources();
        },
    });

    const retry = useMutation({
        mutationFn: (sourceId: string) => retrySource(notebookId, sourceId),
        onSuccess: refreshSources,
    });

    const giveUp = useMutation({
        mutationFn: (sourceId: string) => cancelSource(notebookId, sourceId),
        onSuccess: refreshSources,
    });

    // Pinning floats a notebook to the top of the list. It is the one piece of
    // notebook metadata worth changing from a phone — renaming and instructions
    // belong where there is a keyboard and the document beside them.
    const pin = useMutation({
        mutationFn: (next: boolean) => updateNotebook(notebookId, { pinned: next }),
        onSuccess: (_result, next) => {
            setPinnedOverride(next);
            void queryClient.invalidateQueries({ queryKey: ['library', 'notebooks'] });
        },
    });

    const remove = useMutation({
        mutationFn: (sourceId: string) => deleteSourceRequest(notebookId, sourceId),
        onSuccess: () => {
            setPendingDelete(null);
            toast('Source removed', 'success');
            refreshSources();
        },
    });

    // Only fetched once the chat half is opened: the transcript is an
    // encrypted blob and decrypting it for a screen nobody looked at is work
    // for nothing.
    const conversation = useQuery({
        queryKey: libraryKeys.notebookConversation(notebookId),
        queryFn: ({ signal }) => getNotebookConversation(notebookId, signal),
        enabled: Boolean(notebookId) && tab === 'chat',
    });

    const preview = useQuery({
        queryKey: ['library', 'notebook', notebookId, 'source', previewOf?.id ?? ''],
        queryFn: ({ signal }) => getSourceContent(notebookId, previewOf?.id ?? '', signal),
        enabled: Boolean(previewOf),
    });
    const previewContent = preview.data?.content ?? '';

    const history = useMemo<ChatMessage[]>(
        () =>
            (conversation.data?.messages ?? []).map((m, i) => ({
                // The stored turns have no ids of their own — they are a JSON
                // array inside one encrypted column — so position is the key.
                id: `stored-${i}`,
                role: m.role,
                content: m.content,
                createdAt: m.createdAt,
            })),
        [conversation.data],
    );

    /**
     * `pinned` lives on the card projection, not on the notebook row the detail
     * route returns, so it is read back from whichever list cache this screen
     * was opened from — and false when that cache is cold. This component does
     * not subscribe to that query, so a successful toggle is reflected by
     * `pinnedOverride` rather than by waiting for a re-render that may not come.
     */
    const cachedPinned = Boolean(
        queryClient
            .getQueriesData<{ notebooks: { id: string; pinned: boolean }[] }>({
                queryKey: ['library', 'notebooks'],
            })
            .flatMap(([, data]) => data?.notebooks ?? [])
            .find((card) => card.id === notebookId)?.pinned,
    );
    const pinned = pinnedOverride ?? cachedPinned;

    const readyCount = sources.filter((s) => s.status === 'ready').length;
    const workingCount = sources.filter(isWorking).length;

    return (
        <Screen edges={['top', 'bottom']} avoidKeyboard>
            <Stack.Screen options={{ headerShown: false }} />

            <ScreenHeader
                title={notebook?.name ?? 'Notebook'}
                subtitle={`${plural(readyCount, 'source')} ready${
                    workingCount > 0 ? ` · ${workingCount} processing` : ''
                }`}
                actions={
                    <>
                        <IconButton
                            icon={
                                <Feather
                                    name="bookmark"
                                    size={20}
                                    color={
                                        pinned
                                            ? theme.colors.accentText
                                            : theme.colors.textSecondary
                                    }
                                />
                            }
                            accessibilityLabel={pinned ? 'Unpin this notebook' : 'Pin this notebook'}
                            disabled={pin.isPending || !notebook}
                            onPress={() => pin.mutate(!pinned)}
                        />
                        <IconButton
                            icon={<Feather name="plus" size={20} color={theme.colors.textPrimary} />}
                            accessibilityLabel="Add a source"
                            onPress={() => setAddOpen(true)}
                        />
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
                <Chip label="Sources" selected={tab === 'sources'} onPress={() => setTab('sources')} />
                <Chip label="Chat" selected={tab === 'chat'} onPress={() => setTab('chat')} />
            </View>

            {tab === 'sources' ? (
                query.isLoading ? (
                    <ListSkeleton />
                ) : query.isError ? (
                    <ErrorState error={query.error} onRetry={() => void query.refetch()} />
                ) : (
                    <FlatList
                        data={sources}
                        keyExtractor={(s) => s.id}
                        refreshControl={
                            <RefreshControl
                                refreshing={query.isRefetching}
                                onRefresh={() => void query.refetch()}
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
                                {sources.length > 0 ? <SourceSummary sources={sources} /> : null}
                            </View>
                        }
                        ListEmptyComponent={
                            uploads.active ? null : (
                                <EmptyState
                                    icon="file-plus"
                                    title="No sources yet"
                                    message="Add a file, scan a page with the camera, or paste a link. Everything is processed on your own server."
                                    actionLabel="Add a source"
                                    onAction={() => setAddOpen(true)}
                                />
                            )
                        }
                        contentContainerStyle={{ paddingVertical: theme.spacing.md, paddingBottom: 96 }}
                        renderItem={({ item }) => (
                            <SourceRow
                                source={item}
                                onPress={() => setPreviewOf(item)}
                                onRetry={() => retry.mutate(item.id)}
                                onCancel={() => giveUp.mutate(item.id)}
                                onDelete={() => setPendingDelete(item)}
                            />
                        )}
                    />
                )
            ) : (
                <View style={{ flex: 1 }}>
                    {conversation.data?.locked ? (
                        <View style={{ paddingHorizontal: theme.spacing.lg, paddingBottom: theme.spacing.sm }}>
                            <Banner tone="warning" icon="lock">
                                This notebook&rsquo;s history is encrypted with a key this device does not
                                have. Unlock encryption to read and continue it.
                            </Banner>
                        </View>
                    ) : workingCount > 0 ? (
                        <View style={{ paddingHorizontal: theme.spacing.lg, paddingBottom: theme.spacing.sm }}>
                            <Banner tone="info" icon="clock">
                                {plural(workingCount, 'source')} still processing — answers will improve
                                once they finish.
                            </Banner>
                        </View>
                    ) : null}

                    {conversation.isLoading ? (
                        <ListSkeleton rows={4} />
                    ) : (
                        <LibraryChat
                            streamPath="/ai/chat/notebook/stream"
                            extraBody={{
                                notebookId,
                                // The server builds a [DOCUMENT] block from this.
                                // Sending the stored copy keeps the model aware of
                                // the notebook's own document even though the phone
                                // has no editor for it.
                                documentContent: notebook?.documentContent ?? '',
                            }}
                            initialMessages={history}
                            locked={conversation.data?.locked}
                            emptyTitle="Ask this notebook anything"
                            emptyMessage={
                                readyCount === 0
                                    ? 'Add a source first — right now there is nothing for it to read.'
                                    : `Answers are drawn from the ${plural(readyCount, 'source')} in this notebook.`
                            }
                            placeholder="Ask about these sources"
                            onSourceAdded={refreshSources}
                            onTurnComplete={() => {
                                void queryClient.invalidateQueries({
                                    queryKey: libraryKeys.notebookConversation(notebookId),
                                });
                            }}
                        />
                    )}
                </View>
            )}

            <Sheet
                visible={addOpen}
                onClose={() => setAddOpen(false)}
                title="Add a source"
                subtitle={notebook?.name}
                scroll={false}
            >
                <AddSourceBody
                    accepts="PDF, Word, Excel, CSV or text · up to 50 MB"
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
                baseName={notebook?.name ? `${notebook.name} scan` : 'Scan'}
                onCapture={(files) => {
                    setScanOpen(false);
                    uploads.add(files);
                }}
            />

            <PreviewSheet
                visible={Boolean(previewOf)}
                onClose={() => setPreviewOf(null)}
                title={previewOf?.name ?? ''}
                subtitle="The extracted text — this is what the model reads"
                // URL sources are stored as converted markdown; everything else
                // is plain extracted text.
                kind={previewOf?.type === 'url' ? 'markdown' : 'text'}
                content={previewContent}
                loading={preview.isLoading}
                error={preview.isError ? preview.error : undefined}
                onRetry={() => void preview.refetch()}
                onShare={
                    previewContent
                        ? () => void shareText(previewContent, previewOf?.name ?? 'source')
                        : undefined
                }
            />

            <ConfirmSheet
                visible={Boolean(pendingDelete)}
                title={`Remove “${pendingDelete?.name ?? ''}”?`}
                message="The file and everything indexed from it are deleted. The notebook keeps its chat."
                confirmLabel="Remove source"
                busy={remove.isPending}
                onCancel={() => setPendingDelete(null)}
                onConfirm={() => pendingDelete && remove.mutate(pendingDelete.id)}
            />

            {uploads.active ? (
                <View
                    style={{
                        position: 'absolute',
                        left: 0,
                        right: 0,
                        bottom: 0,
                        padding: theme.spacing.lg,
                        borderTopWidth: StyleSheet.hairlineWidth,
                        borderTopColor: theme.colors.borderSubtle,
                        backgroundColor: theme.colors.bgSecondary,
                    }}
                    accessibilityLiveRegion="polite"
                >
                    <Button
                        label="Uploading…"
                        variant="secondary"
                        fullWidth
                        loading
                        onPress={() => setTab('sources')}
                    />
                </View>
            ) : null}
        </Screen>
    );
}
