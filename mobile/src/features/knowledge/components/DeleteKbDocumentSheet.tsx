/** Delete one document from this knowledge base, so agents stop finding it. */

import React from 'react';

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
    const { toast } = useToast();
    const remove = useDeleteKbDocument({
        onSuccess: () => {
            onDone();
            toast('Document deleted', 'success');
        },
    });

    return (
        <ConfirmSheet
            visible={Boolean(doc)}
            title={`Delete “${doc?.title ?? ''}”?`}
            message="The document and its chunks are removed from this knowledge base, so agents will stop finding it."
            confirmLabel="Delete document"
            busy={remove.isPending}
            onCancel={onDone}
            onConfirm={() => doc && remove.mutate({ kbId, docId: doc.id })}
        />
    );
}
