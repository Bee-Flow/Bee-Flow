/**
 * An e-mail the assistant drafted (the web's EmailDraftCard): who it goes to,
 * the subject and the body, with Send and Save as Draft. Nothing leaves the
 * workspace until a person presses one of them; the body posted is the
 * allow-listed one (draftPayloads.ts), never the streamed record.
 */

import React from 'react';
import { Linking } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { saveEmailDraft, sendEmailDraft } from '@/features/chat/api/drafts';
import { useDraftAction, type DraftState } from '@/features/chat/hooks/useDraftAction';
import { isOutlook } from '@/features/chat/model/draftPayloads';
import { text } from '@/features/chat/model/draftView';
import type { DraftRecord } from '@/features/chat/model/types';
import { Button } from '@/shared/ui';

import { DraftCardShell } from './DraftCardShell';
import { DraftField } from './DraftField';
import { DraftText } from './DraftText';

type T = ReturnType<typeof useTranslation>;

function headerOf(state: DraftState, reply: boolean, t: T): string {
    switch (state.status) {
        case 'done':
            return t('chat.draft.mail_sent', 'Email Sent ✓');
        case 'saved':
            return t('chat.draft.mail_saved', 'Saved to Drafts ✓');
        case 'discarded':
            return t('chat.draft.mail_discarded', 'Email Discarded');
        case 'working':
            return t('chat.draft.mail_sending', 'Sending...');
        case 'saving':
            return t('chat.draft.mail_saving', 'Saving Draft...');
        case 'failed':
            return t('chat.draft.mail_failed', 'Send Failed');
        default:
            return reply
                ? t('mobile.chat.draft_mail_reply_pending', 'Reply Draft — Awaiting Approval')
                : t('mobile.chat.draft_mail_pending', 'Email Draft — Awaiting Approval');
    }
}

export function EmailDraftCard({ draft, draftKey }: { draft: DraftRecord; draftKey: string }) {
    const t = useTranslation();
    const state = useDraftAction(draftKey, draft.status);
    const busy = state.status === 'working' || state.status === 'saving';
    return (
        <DraftCardShell
            state={state}
            header={headerOf(state, Boolean(draft.replyToMessageId), t)}
            icon="Mail"
            tone="info"
            actions={
                <>
                    <Button
                        label={t('chat.draft.mail_send', 'Send Email')}
                        iconName="Send"
                        variant="success"
                        size="sm"
                        loading={state.status === 'working'}
                        disabled={busy}
                        onPress={() => state.run(() => sendEmailDraft(draft))}
                    />
                    <Button
                        label={t('chat.draft.mail_save_draft', 'Save as Draft')}
                        iconName="FileText"
                        size="sm"
                        loading={state.status === 'saving'}
                        disabled={busy}
                        onPress={() => state.run(() => saveEmailDraft(draft), { saving: true })}
                    />
                </>
            }
        >
            <DraftField label={t('chat.draft.mail_to', 'To:')} value={text(draft, 'to')} />
            <DraftField label={t('chat.draft.mail_cc', 'Cc:')} value={text(draft, 'cc')} />
            <DraftField label={t('chat.draft.mail_bcc', 'Bcc:')} value={text(draft, 'bcc')} />
            <DraftField label={t('chat.draft.mail_subject', 'Subject:')} value={text(draft, 'subject')} strong />
            <DraftText value={text(draft, 'body')} />
            {state.status === 'saved' && state.link ? (
                <Button
                    label={t('chat.draft.mail_open_in', 'Open draft in {provider} →', { provider: isOutlook(draft) ? 'Outlook' : 'Gmail' })}
                    variant="ghost"
                    size="sm"
                    onPress={() => void Linking.openURL(state.link as string).catch(() => undefined)}
                />
            ) : null}
        </DraftCardShell>
    );
}
