/** A LinkedIn post the assistant drafted, with its length against LinkedIn's 3,000, and Post. */

import React from 'react';

import { useTranslation } from '@/core/i18n';
import { postLinkedInDraft } from '@/features/chat/api/drafts';
import { useDraftAction, type DraftState } from '@/features/chat/hooks/useDraftAction';
import { text } from '@/features/chat/model/draftView';
import type { DraftRecord } from '@/features/chat/model/types';
import { Button, Text } from '@/shared/ui';

import { DraftCardShell } from './DraftCardShell';
import { DraftText } from './DraftText';

function headerOf(state: DraftState, t: ReturnType<typeof useTranslation>): string {
    switch (state.status) {
        case 'done':
            return t('chat.draft.li_posted', 'Posted to LinkedIn ✓');
        case 'discarded':
            return t('chat.draft.li_discarded', 'Post Discarded');
        case 'working':
            return t('chat.draft.li_posting', 'Posting...');
        case 'failed':
            return t('chat.draft.li_failed', 'Post Failed');
        default:
            return t('chat.draft.li_pending', 'LinkedIn Draft — Awaiting Approval');
    }
}

export function LinkedInDraftCard({ draft, draftKey }: { draft: DraftRecord; draftKey: string }) {
    const t = useTranslation();
    const state = useDraftAction(draftKey, draft.status);
    const post = text(draft, 'text');
    return (
        <DraftCardShell
            state={state}
            header={headerOf(state, t)}
            icon="Share2"
            tone="info"
            actions={
                <Button
                    label={t('chat.draft.li_post', 'Post to LinkedIn')}
                    iconName="Send"
                    size="sm"
                    loading={state.status === 'working'}
                    onPress={() => state.run(() => postLinkedInDraft(draft))}
                />
            }
        >
            <DraftText value={post} />
            <Text variant="label" tone="tertiary">
                {t('chat.draft.li_char_count', '{used} / 3,000 characters', { used: post.length.toLocaleString() })}
            </Text>
        </DraftCardShell>
    );
}
