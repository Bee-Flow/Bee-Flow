/**
 * Deleting a knowledge base: an unconfirmed request first; a base that
 * something still uses (or that the server could not fully check) comes back
 * 409, and the guard sheet shows that list before it confirms with `?confirm=1`.
 * The list and the detail screen share it.
 */

import React, { useState } from 'react';

import { readDeleteGuard, type DeleteGuard } from '@/core/api/deleteGuard';
import { describeError } from '@/core/api/errors';
import { useTranslation } from '@/core/i18n';
import { ConfirmSheet, GuardedDeleteSheet, useToast } from '@/shared/ui';

import { useDeleteKnowledgeBase } from '../hooks/mutations';
import type { KnowledgeBase } from '../model/types';

export function KbDeleteSheets({
    kb,
    onDone,
    onDeleted,
}: {
    kb: KnowledgeBase | null;
    /** The first confirmation closed — cancelled, refused or done. */
    onDone: () => void;
    /** The base is gone. */
    onDeleted?: () => void;
}) {
    const t = useTranslation();
    const { toast } = useToast();
    // The base the server refused to delete, and what it said about it.
    const [guarded, setGuarded] = useState<{ kb: KnowledgeBase; guard: DeleteGuard } | null>(null);

    const remove = useDeleteKnowledgeBase({
        onSuccess: () => {
            toast(t('mobile.knowledge.deleted', 'Knowledge base deleted'), 'success');
            onDone();
            setGuarded(null);
            onDeleted?.();
        },
        onError: (err, vars) => {
            onDone();
            const refused = readDeleteGuard(err, 'knowledgeBase');
            if (refused.blocked) {
                setGuarded({ kb: vars.kb, guard: refused });
                return;
            }
            setGuarded(null);
            toast(describeError(err).message, 'error');
        },
    });

    return (
        <>
            <ConfirmSheet
                visible={Boolean(kb)}
                title={t('usage.delete_question', 'Delete “{name}” for good?', { name: kb?.name ?? '' })}
                message={t(
                    'mobile.knowledge.delete_message',
                    'Its documents, chunks and embeddings are removed everywhere they were indexed. Agents that searched it will stop finding anything. This cannot be undone.',
                )}
                confirmLabel={t('knowledge.settings.delete_open', 'Delete this knowledge base')}
                busy={remove.isPending}
                onCancel={onDone}
                onConfirm={() => kb && remove.mutate({ kb, confirmed: false })}
            />

            <GuardedDeleteSheet
                guard={guarded?.guard ?? null}
                name={guarded?.kb.name ?? ''}
                busy={remove.isPending}
                onConfirm={() => guarded && remove.mutate({ kb: guarded.kb, confirmed: true })}
                onCancel={() => setGuarded(null)}
            />
        </>
    );
}
