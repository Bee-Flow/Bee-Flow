/** Delete one indexed document, from whichever knowledge base holds it. */

import React from 'react';

import { useTranslation } from '@/core/i18n';
import { useDeleteKbDocument } from '@/features/knowledge';
import { ConfirmSheet, useToast } from '@/shared/ui';

import type { OwnedDocument } from '../model/types';

export function DeleteDocumentSheet({ doc, onDone }: { doc: OwnedDocument | null; onDone: () => void }) {
    const t = useTranslation();
    const { toast } = useToast();
    const remove = useDeleteKbDocument({
        onSuccess: () => {
            onDone();
            toast(t('mobile.documents.deleted', 'Document deleted'), 'success');
        },
    });

    return (
        <ConfirmSheet
            visible={Boolean(doc)}
            title={t('knowledge.sources.delete_title', 'Delete “{name}”?', { name: doc?.title ?? '' })}
            message={t('mobile.documents.delete_message', 'It is removed from {kb}, along with everything indexed from it.', {
                kb: doc?.kbName ?? t('mobile.documents.its_kb', 'its knowledge base'),
            })}
            confirmLabel={t('documents.delete', 'Delete document')}
            busy={remove.isPending}
            onCancel={onDone}
            onConfirm={() => doc && remove.mutate({ kbId: doc.kbId, docId: doc.id })}
        />
    );
}
