/**
 * Deleting a page is TWO presses, because the server answers the question in
 * between.
 *
 * The first request goes out unconfirmed. The guard refuses it with 409 and a
 * payload naming what uses the page and which kinds it could not check — and
 * it refuses EVERY first request, because `chat` and `agent` are structurally
 * unanswerable. So a 409 is not an error here: it is the expected first
 * outcome, and only a non-409 failure reaches the toast.
 */

import { useRouter } from 'expo-router';
import React, { useState } from 'react';

import { readDeleteGuard, type DeleteGuard } from '@/core/api/deleteGuard';
import { describeError } from '@/core/api/errors';
import { useTranslation } from '@/core/i18n';
import { ConfirmSheet, GuardedDeleteSheet, useToast } from '@/shared/ui';

import { useDeleteWebpage } from '../hooks/mutations';

export function DeletePageSheets({
    pageId,
    name,
    visible,
    onClose,
}: {
    pageId: string;
    name: string;
    visible: boolean;
    onClose: () => void;
}) {
    const t = useTranslation();
    const router = useRouter();
    const { toast } = useToast();
    // What the server said when it refused the first request: the answer the
    // second sheet shows, which makes the second press an INFORMED one.
    const [deleteBlock, setDeleteBlock] = useState<DeleteGuard | null>(null);

    const removePage = useDeleteWebpage(pageId, {
        onSuccess: () => {
            onClose();
            setDeleteBlock(null);
            toast(t('mobile.webpages.delete.done', 'Page deleted'), 'success');
            router.back();
        },
        onError: (err) => {
            onClose();
            const refused = readDeleteGuard(err, 'webpage');
            setDeleteBlock(refused.blocked ? refused : null);
            if (!refused.blocked) toast(describeError(err).message, 'error');
        },
    });

    return (
        <>
            <ConfirmSheet
                visible={visible}
                title={
                    name
                        ? t('mobile.webpages.delete.title', 'Delete {name}?', { name })
                        : t('mobile.webpages.delete.title_unnamed', 'Delete this page?')
                }
                message={t(
                    'mobile.webpages.delete.body',
                    'The page, its version history and all of its external links go with it. This cannot be undone.',
                )}
                confirmLabel={t('mobile.webpages.menu.delete', 'Delete page')}
                busy={removePage.isPending}
                onConfirm={() => removePage.mutate(false)}
                onCancel={onClose}
            />
            {/* The guard's answer, and the only place the confirmed request is sent from. */}
            <GuardedDeleteSheet
                guard={deleteBlock}
                name={name}
                busy={removePage.isPending}
                onConfirm={() => removePage.mutate(true)}
                onCancel={() => setDeleteBlock(null)}
            />
        </>
    );
}
