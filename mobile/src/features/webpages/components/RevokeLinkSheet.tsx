/** Revoke an external link: the address stops working and its snapshot is deleted. */

import React from 'react';

import { describeError } from '@/core/api/errors';
import { useTranslation } from '@/core/i18n';
import { ConfirmSheet, useToast } from '@/shared/ui';

import { useRevokeWebpageShare } from '../hooks/mutations';
import type { WebpageShare } from '../model/types';

export function RevokeLinkSheet({
    pageId,
    share,
    onDone,
}: {
    pageId: string;
    share: WebpageShare | null;
    onDone: () => void;
}) {
    const t = useTranslation();
    const { toast } = useToast();
    const revokeLink = useRevokeWebpageShare(pageId, {
        onSuccess: () => {
            onDone();
            toast(t('mobile.webpages.link.revoked', 'Link revoked'), 'success');
        },
        onError: (err) => {
            onDone();
            toast(describeError(err).message, 'error');
        },
    });

    return (
        <ConfirmSheet
            visible={share !== null}
            title={t('mobile.webpages.link.revoke_title', 'Revoke this link?')}
            message={t(
                'mobile.webpages.link.revoke_body',
                'The address stops working immediately and the snapshot behind it is deleted. Anyone you sent it to will get a not-found page.',
            )}
            confirmLabel={t('mobile.webpages.link.revoke_confirm', 'Revoke link')}
            busy={revokeLink.isPending}
            onConfirm={() => {
                if (share) revokeLink.mutate(share.id);
            }}
            onCancel={onDone}
        />
    );
}
