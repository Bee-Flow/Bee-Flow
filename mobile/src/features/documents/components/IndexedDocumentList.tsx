/**
 * The Indexed tab's list: every document the fan-out found, with the upload
 * queue above it. It stays mounted while empty, so a first upload's progress
 * is visible.
 */

import React from 'react';
import { FlatList, RefreshControl, StyleSheet, View } from 'react-native';

import { useTheme, useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { UploadQueue, type IngestFlow } from '@/features/knowledge';
import { useUserRefresh } from '@/shared/patterns';
import { EmptyState, ErrorState, ListSkeleton, Text } from '@/shared/ui';

import { OwnedDocumentRow } from './OwnedDocumentRow';
import type { useIndexedDocuments } from '../hooks/useIndexedDocuments';
import type { OwnedDocument } from '../model/types';

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        header: { paddingHorizontal: theme.spacing.lg, gap: theme.spacing.md },
        content: { paddingVertical: theme.spacing.md, paddingBottom: 96 },
    });

function ListHeader({ data, uploads }: { data: ReturnType<typeof useIndexedDocuments>; uploads: IngestFlow['uploads'] }) {
    const styles = useThemedStyles(makeStyles);
    return (
        <View style={styles.header}>
            {uploads.items.length > 0 ? (
                <UploadQueue
                    items={uploads.items}
                    onRetry={uploads.retry}
                    onRemove={uploads.remove}
                    onClearFinished={uploads.clearFinished}
                />
            ) : null}
            {(data.indexed.data?.skipped ?? 0) > 0 ? (
                <Text variant="label" tone="tertiary">
                    Showing documents from your {data.scopedBases.length} most recent
                    knowledge bases. Open a specific one to see the rest.
                </Text>
            ) : null}
        </View>
    );
}

export function IndexedDocumentList({
    data,
    uploads,
    searching,
    onOpen,
    onDelete,
    onAdd,
}: {
    data: ReturnType<typeof useIndexedDocuments>;
    uploads: IngestFlow['uploads'];
    /** A search is typed: an empty list is a miss, not "none yet". */
    searching: boolean;
    onOpen: (doc: OwnedDocument) => void;
    onDelete: (doc: OwnedDocument) => void;
    onAdd: () => void;
}) {
    const theme = useTheme();
    const styles = useThemedStyles(makeStyles);
    const { bases, indexed } = data;
    const refresh = useUserRefresh(() => indexed.refetch());

    if (bases.isLoading || indexed.isLoading) return <ListSkeleton />;
    if (bases.isError) return <ErrorState error={bases.error} onRetry={() => void bases.refetch()} />;
    if (indexed.isError) return <ErrorState error={indexed.error} onRetry={() => void indexed.refetch()} />;

    return (
        <FlatList
            data={data.documents}
            keyExtractor={(doc) => `${doc.kbId}-${doc.id}`}
            refreshControl={
                <RefreshControl
                    refreshing={refresh.refreshing}
                    onRefresh={refresh.onRefresh}
                    tintColor={theme.colors.accentPrimary}
                    colors={[theme.colors.accentPrimary]}
                />
            }
            ListHeaderComponent={<ListHeader data={data} uploads={uploads} />}
            ListEmptyComponent={
                uploads.active ? null : (
                    <EmptyState
                        icon="FileText"
                        title={searching ? 'Nothing matches that' : 'No documents yet'}
                        message={
                            searching
                                ? 'Try a different word.'
                                : 'Upload a file or scan a page into a knowledge base and it becomes searchable everywhere.'
                        }
                        actionLabel={searching ? undefined : 'Add a document'}
                        onAction={searching ? undefined : onAdd}
                    />
                )
            }
            contentContainerStyle={styles.content}
            renderItem={({ item }) => (
                <OwnedDocumentRow doc={item} onPress={() => onOpen(item)} onLongPress={() => onDelete(item)} />
            )}
        />
    );
}
