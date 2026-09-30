// A system message in a team chat: a notice with a code and no text, told in
// the reader's words. Today there is one: somebody set the chat to Auto, so
// the AI may now join by itself — said once, in the conversation, with the way
// to one's own opt-out right next to it.

import { Sparkles } from 'lucide-react';
import React from 'react';
import type { TeamChatMessage } from '../../../../api/queries/projectChats';
import { useTranslation, type TranslateFn } from '../../../../hooks/useTranslation';

/** The notice as one line, for the chat list's excerpt. */
export function noticeExcerpt(notice: string | null | undefined, t: TranslateFn): string {
    if (notice === 'ai_auto_on') return t('project_participation.list_notice_auto_on', 'The AI now joins by itself');
    return t('project_participation.notice_other', 'The chat settings changed');
}

export default function SystemNotice({ message, nameOf, currentUserId, onShowAiSettings }: {
    message: TeamChatMessage;
    nameOf: (userId: string | null | undefined) => string;
    currentUserId: string | null;
    onShowAiSettings?: () => void;
}) {
    const { t } = useTranslation();
    if (message.deleted) return null;
    const mine = !!currentUserId && message.authorUserId === currentUserId;
    const text = message.notice === 'ai_auto_on'
        ? (mine
            ? t('project_participation.notice_auto_on_you', 'You let the AI join this chat by itself. It answers when it can help, and says why.')
            : t('project_participation.notice_auto_on', '{name} let the AI join this chat by itself. It answers when it can help, and says why.', { name: nameOf(message.authorUserId) }))
        : noticeExcerpt(message.notice, t);
    return (
        <li className="flex justify-center px-4 py-2" data-testid={`team-chat-notice-${message.id}`}>
            <div className="max-w-xl flex items-start gap-2 px-3 py-2 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-secondary)] text-[12px] text-[var(--text-secondary)]">
                <Sparkles className="w-3.5 h-3.5 mt-0.5 flex-shrink-0 text-[var(--accent-primary)]" aria-hidden="true" />
                <p className="m-0">
                    {text}
                    {message.notice === 'ai_auto_on' && (
                        onShowAiSettings
                            ? <> <button type="button" onClick={onShowAiSettings}
                                className="underline underline-offset-2 text-[var(--accent-primary)] hover:opacity-80 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent-primary)] rounded">
                                {t('project_participation.notice_opt_out_link', 'Your AI settings')}
                            </button></>
                            : <> {t('project_participation.notice_opt_out_hint', 'You can keep it from joining after your own messages in Settings, Preferences.')}</>
                    )}
                </p>
            </div>
        </li>
    );
}
