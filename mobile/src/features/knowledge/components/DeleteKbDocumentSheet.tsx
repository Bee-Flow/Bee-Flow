/** Delete one document from this knowledge base, so agents stop finding it. */

import React from 'react';

import { useTranslation } from '@/core/i18n';
import { ConfirmSheet, useToast } from '@/shared/ui';

import { useDeleteKbDocument } from '../hooks/mutations';
import type { KbDocument } from '../model/types';

export function DeleteKbDocumentSheet({
    kbId,
    doc,
    onDone,
}: {
    kbId: string;
    doc: KbDocument | null;
    onDone: () => void;
}) {
    const t = useTranslation();
    const { toast } = useToast();
    const remove = useDeleteKbDocument({
        onSuccess: () => {
            onDone();
            toast(t('mobile.knowledge.doc_deleted', 'Document deleted'), 'success');
        },
    });

    return (
        <ConfirmSheet
            visible={Boolean(doc)}
            title={t('mobile.knowledge.doc_delete_title', 'Delete “{title}”?', { title: doc?.title ?? '' })}
            message={t('mobile.knowledge.doc_delete_message', 'The document and its chunks are removed from this knowledge base, so agents will stop finding it.')}
            confirmLabel={t('mobile.knowledge.doc_delete', 'Delete document')}
            busy={remove.isPending}
            onCancel={onDone}
            onConfirm={() => doc && remove.mutate({ kbId, docId: doc.id })}
        />
    );
}
