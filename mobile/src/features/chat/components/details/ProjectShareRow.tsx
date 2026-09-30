/**
 * Sharing this chat INTO its project as a thread every member can read (the
 * web's "Share with project"). Sharing re-keys the transcript to the
 * organisation's key, so the switch asks first and says so; only the owner
 * may do it, and the server says when someone else tries.
 */

import React, { useState } from 'react';

import { useTranslation } from '@/core/i18n';
import type { ChatDetails } from '@/features/chat/hooks/useChatDetails';
import { ConfirmSheet, ToggleRow } from '@/shared/ui';


export function ProjectShareRow({ details, projectId }: { details: ChatDetails; projectId: string }) {
    const t = useTranslation();
    const [asking, setAsking] = useState(false);
    const shared = details.conversation?.shared_scope === 'project';
    const busy = details.shareToProject.isPending;
    const run = (share: boolean) => details.shareToProject.mutate({ projectId, share });

    return (
        <>
            <ToggleRow
                label={shared ? t('projects.shared_badge', 'Shared with the project') : t('projects.share_thread', 'Share with project')}
                description={t('projects.share_owner_only', "Only a conversation's owner can share it.")}
                value={shared}
                disabled={busy}
                onValueChange={(on) => (on ? setAsking(true) : run(false))}
            />
            <ConfirmSheet
                visible={asking}
                title={t('projects.share_thread', 'Share with project')}
                message={t(
                    'projects.share_encryption_warning',
                    'Shared conversations are encrypted with an organisation key so every project member and background jobs can read them. Your private conversations are unchanged.',
                )}
                confirmLabel={t('projects.share_thread', 'Share with project')}
                tone="primary"
                onConfirm={() => {
                    setAsking(false);
                    run(true);
                }}
                onCancel={() => setAsking(false)}
            />
        </>
    );
}
