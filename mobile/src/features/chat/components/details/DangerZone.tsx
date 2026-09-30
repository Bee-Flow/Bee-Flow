/** Delete the conversation — every message, from the server, for good. */

import React from 'react';

import { useTranslation } from '@/core/i18n';
import type { ChatDetails } from '@/features/chat/hooks/useChatDetails';
import { useConfirm } from '@/shared/patterns';
import { Button, Section, Text } from '@/shared/ui';


export function DangerZone({ details }: { details: ChatDetails }) {
    const t = useTranslation();
    const confirm = useConfirm();
    const { conversation, destroy } = details;

    const askToDelete = async () => {
        const ok = await confirm({
            title: t('mobile.chat.details.delete_title', 'Delete this conversation?'),
            message: t(
                'mobile.chat.details.delete_message',
                '“{title}” and all {count} of its messages will be permanently removed from your server.',
                { title: conversation?.title || t('sidebar.untitled_chat', 'Untitled Chat'), count: conversation?.messages?.length ?? 0 },
            ),
            confirmLabel: t('common.delete', 'Delete'),
        });
        if (ok) destroy.mutate();
    };

    return (
        <Section title={t('mobile.chat.details.danger_zone', 'Danger zone')}>
            <Text variant="caption" tone="tertiary">
                {t(
                    'mobile.chat.details.delete_caption',
                    'Deleting removes the conversation and every message in it from your server. This cannot be undone.',
                )}
            </Text>
            <Button
                label={t('mobile.chat.details.delete_conversation', 'Delete conversation')}
                variant="danger"
                loading={destroy.isPending}
                onPress={() => void askToDelete()}
            />
        </Section>
    );
}
