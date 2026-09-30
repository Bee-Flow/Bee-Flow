/**
 * History: every saved revision, newest first, and restoring one — which is
 * itself a new revision, so nothing is lost by it (the web's history drawer).
 */

import React, { createContext, useContext } from 'react';
import { FlatList, StyleSheet, type ListRenderItem } from 'react-native';

import { describeError } from '@/core/api/errors';
import { timeAgo, useTranslation } from '@/core/i18n';
import { useTheme } from '@/core/theme/ThemeProvider';
import { useConfirm } from '@/shared/patterns';
import { EmptyState, ErrorState, Icon, IconButton, InsetDivider, ListRow, ListSkeleton, useToast } from '@/shared/ui';

import { useRestoreVersion } from '../hooks/mutations';
import { useDocumentVersions } from '../hooks/queries';
import type { DocumentVersion } from '../model/types';

const styles = StyleSheet.create({ list: { paddingBottom: 48 } });
const keyOf = (v: DocumentVersion) => v.id;

interface RowContextValue {
    editable: boolean;
    busy: boolean;
    onRestore: (v: DocumentVersion) => void;
}
const RowContext = createContext<RowContextValue>({ editable: false, busy: false, onRestore: () => undefined });

function VersionRow({ version }: { version: DocumentVersion }) {
    const t = useTranslation();
    const theme = useTheme();
    const { editable, busy, onRestore } = useContext(RowContext);
    return (
        <ListRow
            title={version.summary || t('documents.version', 'Version')}
            meta={timeAgo(version.createdAt)}
            chevron={false}
            trailing={
                editable ? (
                    <IconButton
                        icon={<Icon name="RotateCcw" size={16} color={theme.colors.textSecondary} />}
                        accessibilityLabel={t('documents.restore', 'Restore this version')}
                        disabled={busy}
                        onPress={() => onRestore(version)}
                    />
                ) : null
            }
        />
    );
}
const renderVersion: ListRenderItem<DocumentVersion> = ({ item }) => <VersionRow version={item} />;

export interface HistoryTabProps {
    documentId: string;
    editable: boolean;
    /** Saves what is still being typed, so a restore does not race it. */
    beforeRestore: () => Promise<void>;
    /** The document was replaced by an older revision: the editors reload. */
    onRestored: () => void;
}

export function HistoryTab({ documentId, editable, beforeRestore, onRestored }: HistoryTabProps) {
    const t = useTranslation();
    const confirm = useConfirm();
    const { toast } = useToast();
    const versions = useDocumentVersions(documentId, true);
    const restore = useRestoreVersion(documentId, {
        onSuccess: () => {
            toast(t('mobile.studio_documents.history.restored', 'Version restored'), 'success');
            onRestored();
        },
        onError: (error) => toast(describeError(error).message, 'error'),
    });

    const ask = async (v: DocumentVersion) => {
        const ok = await confirm({
            title: t('documents.restore', 'Restore this version'),
            message: t('mobile.studio_documents.history.restore_message', 'The document goes back to this revision. What it is now stays in the history.'),
            confirmLabel: t('routine_editor.version_restore', 'Restore'),
            tone: 'primary',
        });
        if (!ok) return;
        try {
            await beforeRestore();
        } catch {
            return;
        }
        restore.mutate(v.id);
    };

    if (versions.isLoading) return <ListSkeleton />;
    if (versions.isError) return <ErrorState error={versions.error} onRetry={() => void versions.refetch()} />;
    if (!versions.data?.length) return <EmptyState icon="History" title={t('documents.history_empty', 'No earlier versions yet.')} />;
    return (
        <RowContext.Provider value={{ editable, busy: restore.isPending, onRestore: (v) => void ask(v) }}>
            <FlatList
                data={versions.data}
                renderItem={renderVersion}
                keyExtractor={keyOf}
                ItemSeparatorComponent={InsetDivider}
                contentContainerStyle={styles.list}
            />
        </RowContext.Provider>
    );
}
