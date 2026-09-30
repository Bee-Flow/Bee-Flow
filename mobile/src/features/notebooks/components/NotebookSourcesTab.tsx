/**
 * The sources half of a notebook: where ingestion is made visible. The list
 * stays mounted while empty, so a first upload's progress is visible.
 */

import React from 'react';
import { FlatList, RefreshControl, StyleSheet, View } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useTheme, useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { UploadQueue, type IngestFlow } from '@/features/knowledge';
import { useUserRefresh } from '@/shared/patterns';
import { EmptyState, ErrorState, ListSkeleton } from '@/shared/ui';

import { SourceRow } from './SourceRow';
import { SourceSummary } from './SourceSummary';
import { useSourceAction } from '../hooks/mutations';
import type { useNotebook } from '../hooks/queries';
import type { NotebookSource } from '../model/types';

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        header: { paddingHorizontal: theme.spacing.lg, gap: theme.spacing.md },
        content: { paddingVertical: theme.spacing.md, paddingBottom: 96 },
    });

export function NotebookSourcesTab({
    notebookId,
    query,
    sources,
    uploads,
    onPreview,
    onDelete,
    onRename,
    onAdd,
}: {
    notebookId: string;
    query: ReturnType<typeof useNotebook>;
    sources: NotebookSource[];
    uploads: IngestFlow['uploads'];
    onPreview: (source: NotebookSource) => void;
    onDelete: (source: NotebookSource) => void;
    onRename: (source: NotebookSource) => void;
    onAdd: () => void;
}) {
    const t = useTranslation();
    const theme = useTheme();
    const styles = useThemedStyles(makeStyles);
    const retry = useSourceAction(notebookId, 'retry');
    const giveUp = useSourceAction(notebookId, 'cancel');
    const refresh = useUserRefresh(() => query.refetch());

    if (query.isLoading) return <ListSkeleton />;
    if (query.isError) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;

    return (
        <FlatList
            data={sources}
            keyExtractor={(s) => s.id}
            refreshControl={
                <RefreshControl
                    refreshing={refresh.refreshing}
                    onRefresh={refresh.onRefresh}
                    tintColor={theme.colors.accentPrimary}
                    colors={[theme.colors.accentPrimary]}
                />
            }
            ListHeaderComponent={
                <View style={styles.header}>
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
                        icon="FilePlus"
                        title={t('notebooks.add_first_source', 'Add your first source')}
                        message={t(
                            'mobile.notebooks.sources_empty',
                            'Add a file, scan a page with the camera, or paste a link. Everything is processed on your own server.',
                        )}
                        actionLabel={t('notebooks.add_source', 'Add Source')}
                        onAction={onAdd}
                    />
                )
            }
            contentContainerStyle={styles.content}
            renderItem={({ item }) => (
                <SourceRow
                    source={item}
                    onPress={() => onPreview(item)}
                    onRetry={() => retry.mutate(item.id)}
                    onCancel={() => giveUp.mutate(item.id)}
                    onDelete={() => onDelete(item)}
                    onLongPress={() => onRename(item)}
                />
            )}
        />
    );
}
