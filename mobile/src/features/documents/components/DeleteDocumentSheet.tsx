/** Delete one indexed document, from whichever knowledge base holds it. */

import React from 'react';

import { useDeleteKbDocument } from '@/features/knowledge';
import { ConfirmSheet, useToast } from '@/shared/ui';

import type { OwnedDocument } from '../model/types';

export function DeleteDocumentSheet({ doc, onDone }: { doc: OwnedDocument | null; onDone: () => void }) {
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
            message={`It is removed from ${doc?.kbName ?? 'its knowledge base'}, along with everything indexed from it.`}
            confirmLabel="Delete document"
            busy={remove.isPending}
            onCancel={onDone}
            onConfirm={() => doc && remove.mutate({ kbId: doc.kbId, docId: doc.id })}
        />
    );
}
