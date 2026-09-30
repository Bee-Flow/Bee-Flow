/**
 * Rename. The field shows the server's title until the user types; see
 * useChatDetails for why the draft is derived rather than seeded.
 */

import React from 'react';

import { useTranslation } from '@/core/i18n';
import type { ChatDetails } from '@/features/chat/hooks/useChatDetails';
import { Button, Section, TextField } from '@/shared/ui';


export function NameSection({ details }: { details: ChatDetails }) {
    const t = useTranslation();
    const { title, serverTitle, setDraftTitle, saveTitle, patch } = details;
    return (
        <Section title={t('common.name', 'Name')}>
            <TextField
                label={t('mobile.chat.details.name_label', 'Conversation name')}
                value={title}
                onChangeText={setDraftTitle}
                placeholder={t('sidebar.untitled_chat', 'Untitled Chat')}
                returnKeyType="done"
                onSubmitEditing={saveTitle}
                hint={t('mobile.chat.details.name_hint', 'Bee Flow names a chat from its first message; rename it to anything.')}
            />
            <Button
                label={t('mobile.chat.details.save_name', 'Save name')}
                onPress={saveTitle}
                disabled={title.trim() === serverTitle.trim() || patch.isPending}
                loading={patch.isPending}
                variant="secondary"
            />
        </Section>
    );
}
