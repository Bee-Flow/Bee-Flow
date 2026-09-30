/**
 * "Documents" — everything in the base, one row per document: tap to read the
 * indexed text, hold to delete one, or "Select" to delete many at once
 * (POST /:id/documents/bulk-delete, in batches of the route's cap). A batch
 * that fails leaves exactly its documents — and the ones after it — selected.
 */

import React, { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { describeError } from '@/core/api/errors';
import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { useConfirm } from '@/shared/patterns';
import { Button, Text, useToast } from '@/shared/ui';

import { DeleteKbDocumentSheet } from './DeleteKbDocumentSheet';
import { KbChunkPreview } from './KbChunkPreview';
import { KbDocumentList } from './KbDocumentList';
import { useBulkDeleteDocuments } from '../hooks/manage';
import { useKbDocuments } from '../hooks/queries';
import type { UseUploadQueue } from '../hooks/useUploadQueue';
import type { KbDocument } from '../model/types';

const makeStyles = (theme: Theme) =>
    StyleSheet.create({ bar: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm, paddingTop: theme.spacing.sm } });

function SelectBar({ selecting, count, busy, onStart, onCancel, onDelete }: {
    selecting: boolean; count: number; busy: boolean; onStart: () => void; onCancel: () => void; onDelete: () => void;
}) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    if (!selecting) {
        return (
            <View style={styles.bar}>
                <Button size="sm" variant="secondary" iconName="CheckSquare" label={t('mobile.knowledge.select', 'Select')} onPress={onStart} />
            </View>
        );
    }
    return (
        <View style={styles.bar}>
            <Text variant="caption" tone="secondary">{t('mobile.knowledge.selected', '{count} selected', { count })}</Text>
            <Button size="sm" variant="danger" label={t('knowledge.docs.delete', 'Delete')} disabled={count === 0} loading={busy} onPress={onDelete} testID="kb-bulk-delete" />
            <Button size="sm" variant="ghost" label={t('common.cancel', 'Cancel')} onPress={onCancel} />
        </View>
    );
}

export function DocumentsTab({ kbId, systemManaged, canManage, uploads, onAdd }: {
    kbId: string; systemManaged: boolean; canManage: boolean; uploads: UseUploadQueue; onAdd?: () => void;
}) {
    const t = useTranslation();
    const confirm = useConfirm();
    const { toast } = useToast();
    const documents = useKbDocuments(kbId);
    const [selected, setSelected] = useState<Set<string> | null>(null);
    const [previewOf, setPreviewOf] = useState<KbDocument | null>(null);
    const [pendingDelete, setPendingDelete] = useState<KbDocument | null>(null);
    const bulk = useBulkDeleteDocuments(kbId, {
        onSuccess: ({ remaining, error }) => {
            if (error) toast(describeError(error).message, 'error');
            setSelected(remaining.length ? new Set(remaining) : null);
        },
    });
    const toggle = (id: string) => setSelected((s) => {
        const next = new Set(s ?? []);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
    });
    const deleteSelected = async () => {
        const ids = [...(selected ?? [])];
        const ok = await confirm({
            title: t('mobile.knowledge.bulk_delete_title', 'Delete {count} documents?', { count: ids.length }),
            message: t('mobile.knowledge.bulk_delete_message', 'They leave this knowledge base, with everything indexed from them. This cannot be undone.'),
            confirmLabel: t('knowledge.docs.delete', 'Delete'),
            tone: 'destructive',
        });
        if (ok) bulk.mutate(ids);
    };
    const editable = canManage && !systemManaged;
    return (
        <>
            <KbDocumentList
                documents={documents}
                systemManaged={systemManaged}
                uploads={uploads}
                selection={selected ? { ids: selected, toggle } : null}
                header={editable && (documents.data?.documents.length ?? 0) > 0 ? (
                    <SelectBar selecting={selected !== null} count={selected?.size ?? 0} busy={bulk.isPending}
                        onStart={() => setSelected(new Set())} onCancel={() => setSelected(null)} onDelete={() => void deleteSelected()} />
                ) : null}
                onOpen={setPreviewOf}
                onDelete={editable ? setPendingDelete : () => undefined}
                onAdd={editable ? onAdd : undefined}
            />
            <KbChunkPreview
                doc={previewOf ? { kbId, docId: previewOf.id, title: previewOf.title } : null}
                subtitle={t('mobile.knowledge.chunks_in_order', 'The indexed text, in the order it was chunked')}
                onClose={() => setPreviewOf(null)}
            />
            <DeleteKbDocumentSheet kbId={kbId} doc={pendingDelete} onDone={() => setPendingDelete(null)} />
        </>
    );
}
