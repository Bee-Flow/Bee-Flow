/**
 * A knowledge base's documents, with the upload queue above them. The list
 * stays mounted while it is empty so a first upload's progress is visible.
 * With a `selection`, a tap selects instead of opening.
 */

import React, { type ReactElement } from 'react';
import { FlatList, RefreshControl, StyleSheet, View } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useTheme, useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { useUserRefresh } from '@/shared/patterns';
import { Banner, EmptyState, ErrorState, ListSkeleton } from '@/shared/ui';

import { KbDocumentRow } from './KbDocumentRow';
import { UploadQueue } from './UploadQueue';
import type { useKbDocuments } from '../hooks/queries';
import type { UseUploadQueue } from '../hooks/useUploadQueue';
import type { KbDocument } from '../model/types';

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        header: { paddingHorizontal: theme.spacing.lg, gap: theme.spacing.md },
        content: { paddingVertical: theme.spacing.md, paddingBottom: 96 },
    });

export interface DocumentSelection {
    ids: ReadonlySet<string>;
    toggle: (id: string) => void;
}

export function KbDocumentList({
    documents,
    systemManaged,
    uploads,
    selection,
    header,
    onOpen,
    onDelete,
    onAdd,
}: {
    documents: ReturnType<typeof useKbDocuments>;
    /** A system base is kept up to date for you, and says so. */
    systemManaged: boolean;
    uploads: UseUploadQueue;
    selection?: DocumentSelection | null;
    /** Above the uploads — the selection bar. */
    header?: ReactElement | null;
    onOpen: (doc: KbDocument) => void;
    onDelete: (doc: KbDocument) => void;
    onAdd?: () => void;
}) {
    const t = useTranslation();
    const theme = useTheme();
    const styles = useThemedStyles(makeStyles);
    const refresh = useUserRefresh(() => documents.refetch());

    if (documents.isLoading) return <ListSkeleton />;
    if (documents.isError) {
        return <ErrorState error={documents.error} onRetry={() => void documents.refetch()} />;
    }

    return (
        <FlatList
            data={documents.data?.documents ?? []}
            keyExtractor={(doc) => doc.id}
            extraData={selection?.ids}
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
                    {header}
                    {systemManaged ? (
                        <Banner tone="info" icon="Shield">
                            {t('mobile.knowledge.system_banner', 'This is a system knowledge base. It is kept up to date for you and cannot be edited here.')}
                        </Banner>
                    ) : null}
                    {uploads.items.length > 0 ? (
                        <UploadQueue items={uploads.items} onRetry={uploads.retry} onRemove={uploads.remove} onClearFinished={uploads.clearFinished} />
                    ) : null}
                </View>
            }
            ListEmptyComponent={
                uploads.active ? null : (
                    <EmptyState
                        icon="FilePlus"
                        title={t('mobile.knowledge.no_documents', 'No documents yet')}
                        message={t(
                            'mobile.knowledge.no_documents_hint',
                            'Upload a file, scan a page, or point it at a web address. Text is extracted and indexed on your server — then you can ask about it.',
                        )}
                        actionLabel={onAdd ? t('mobile.knowledge.add_document', 'Add a document') : undefined}
                        onAction={onAdd}
                    />
                )
            }
            contentContainerStyle={styles.content}
            renderItem={({ item }) => (
                <KbDocumentRow
                    doc={item}
                    selected={selection ? selection.ids.has(item.id) : undefined}
                    onPress={() => (selection ? selection.toggle(item.id) : onOpen(item))}
                    onLongPress={() => onDelete(item)}
                />
            )}
        />
    );
}
