/**
 * Deleting a meeting asks the server first.
 *
 * Today EVERY first DELETE of a meeting is refused with 409 (the notebook scan
 * can never answer), so the refusal is the expected outcome, not an error: it
 * becomes `guard`, which GuardedDeleteSheet shows — naming what could not be
 * checked and asking for the title — before `?confirm=1` is sent. Only a
 * non-409 failure reaches the toast.
 */

import { useState } from 'react';

import { readDeleteGuard, type DeleteGuard } from '@/core/api/deleteGuard';
import { describeError } from '@/core/api/errors';
import { useTranslation } from '@/core/i18n';
import { useConfirm } from '@/shared/patterns';
import { useToast } from '@/shared/ui';

import { useDeleteTranscription } from './mutations';

export function useMeetingDelete(id: string, onDeleted: () => void) {
    const t = useTranslation();
    const confirm = useConfirm();
    const { toast } = useToast();
    const [guard, setGuard] = useState<DeleteGuard | null>(null);

    const remove = useDeleteTranscription(id, {
        onSuccess: () => {
            setGuard(null);
            onDeleted();
        },
        onError: (err) => {
            const refused = readDeleteGuard(err, 'recording');
            setGuard(refused.blocked ? refused : null);
            if (!refused.blocked) toast(describeError(err).message, 'error');
        },
    });

    /** The owner's first "Delete": a confirm, then the unconfirmed request. */
    const request = async () => {
        const ok = await confirm({
            title: 'Delete this meeting?',
            message: 'The transcript, the notes and the saved audio are all removed. This cannot be undone.',
            confirmLabel: t('common.delete', 'Delete'),
        });
        if (ok) remove.mutate(false);
    };

    return {
        guard,
        busy: remove.isPending,
        request,
        /** Only ever called from the guard sheet, after the title was typed. */
        confirmBreaking: () => remove.mutate(true),
        dismiss: () => setGuard(null),
    };
}
