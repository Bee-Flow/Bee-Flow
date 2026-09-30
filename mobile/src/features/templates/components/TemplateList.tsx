/**
 * The templates, with the upload queue above them. Filtered locally: the
 * whole list is one small response. The list stays mounted while empty so a
 * first upload's progress is visible.
 */

import React from 'react';
import { FlatList, RefreshControl, StyleSheet, View } from 'react-native';

import { useTheme, useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { UploadQueue, type IngestFlow } from '@/features/knowledge';
import { useUserRefresh } from '@/shared/patterns';
import { EmptyState, ErrorState, ListSkeleton } from '@/shared/ui';

import { TemplateRow } from './TemplateRow';
import type { useTemplates } from '../hooks/queries';
import type { Template } from '../model/types';

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        queue: { paddingHorizontal: theme.spacing.lg, paddingBottom: theme.spacing.md },
        content: { paddingVertical: theme.spacing.md, paddingBottom: 96 },
    });

function matches(t: Template, needle: string): boolean {
    return !needle || t.name.toLowerCase().includes(needle) || (t.description ?? '').toLowerCase().includes(needle);
}

export function TemplateList({
    query,
    search,
    uploads,
    onOpen,
    onDelete,
    onUpload,
}: {
    query: ReturnType<typeof useTemplates>;
    search: string;
    uploads: IngestFlow['uploads'];
    onOpen: (template: Template) => void;
    onDelete: (template: Template) => void;
    onUpload: () => void;
}) {
    const theme = useTheme();
    const styles = useThemedStyles(makeStyles);
    const refresh = useUserRefresh(() => query.refetch());

    if (query.isLoading) return <ListSkeleton />;
    if (query.isError) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;

    const needle = search.trim().toLowerCase();
    return (
        <FlatList
            data={(query.data ?? []).filter((t) => matches(t, needle))}
            keyExtractor={(t) => t.id}
            refreshControl={
                <RefreshControl
                    refreshing={refresh.refreshing}
                    onRefresh={refresh.onRefresh}
                    tintColor={theme.colors.accentPrimary}
                    colors={[theme.colors.accentPrimary]}
                />
            }
            ListHeaderComponent={
                uploads.items.length > 0 ? (
                    <View style={styles.queue}>
                        <UploadQueue
                            items={uploads.items}
                            onRetry={uploads.retry}
                            onRemove={uploads.remove}
                            onClearFinished={uploads.clearFinished}
                        />
                    </View>
                ) : null
            }
            ListEmptyComponent={
                uploads.active ? null : (
                    <EmptyState
                        icon="PanelsTopLeft"
                        title={search ? 'Nothing matches that' : 'No templates yet'}
                        message={
                            search
                                ? 'Try a different word.'
                                : 'Upload a Word document with {{placeholders}} in it. Bee Flow finds them and fills them in for you.'
                        }
                        actionLabel={search ? undefined : 'Upload a .docx'}
                        onAction={search ? undefined : onUpload}
                    />
                )
            }
            contentContainerStyle={styles.content}
            renderItem={({ item }) => (
                <TemplateRow template={item} onPress={() => onOpen(item)} onLongPress={() => onDelete(item)} />
            )}
        />
    );
}
