import { MessageSquare, X } from 'lucide-react';
import React, { useEffect, useRef, useState } from 'react';
import { useCreateProjectChat } from '../../../../api/queries/projectChats';
import type { Project } from '../../../../api/queries/projects';
import { useTranslation } from '../../../../hooks/useTranslation';
import { projectErrorText } from '../projectErrorText';
import type { StartChat } from '../types';
import { ErrorText, INPUT_CLASS, PrimaryButton } from '../workspaceUi';
import { MAX_MESSAGE_LENGTH } from './ChatComposer';
import { rememberFirstAnswer } from './firstAnswer';
import { isImeEnter } from './ime';

// Retained as a source compatibility type; project creation always makes one shared chat.
export type NewChatMode = 'team' | 'ai' | 'agent';
export interface NewChatComposerProps {
    mode: NewChatMode; project: Project; onModeChange: (mode: NewChatMode) => void;
    onClose: () => void; onStartChat: StartChat; onOpenTeamChat: (chatId: string) => void;
}
export default function NewChatComposer({ project, onClose, onOpenTeamChat }: NewChatComposerProps) {
    const { t } = useTranslation();
    const [message, setMessage] = useState('');
    const [title, setTitle] = useState('');
    const [error, setError] = useState<string | null>(null);
    const create = useCreateProjectChat(project.id);
    const inputRef = useRef<HTMLInputElement>(null);
    useEffect(() => { inputRef.current?.focus(); }, []);
    const submit = async () => {
        if (create.isPending) return;
        setError(null);
        try {
            const { chat, ai } = await create.mutateAsync({ title, message, aiMode: 'mention' });
            rememberFirstAnswer(chat.id, ai, message);
            onOpenTeamChat(chat.id);
        } catch (e) { setError(projectErrorText(t, e)); }
    };
    return <section className="rounded-2xl border border-[var(--border-default)] bg-[var(--bg-card)] p-5 space-y-4 shadow-sm" data-testid="new-chat-composer" aria-label={t('project_chat.new_chat', 'New chat')}>
        <div className="flex items-center gap-2"><MessageSquare className="w-5 h-5" /><h3 className="flex-1 m-0 text-base font-semibold">{t('project_chat.start_together', 'Start a conversation')}</h3><button type="button" onClick={onClose} aria-label={t('project_chat.close', 'Close')} className="p-2 rounded-lg hover:bg-[var(--item-hover-bg)]"><X className="w-4 h-4" /></button></div>
        <input ref={inputRef} value={title} onChange={e => setTitle(e.target.value)} maxLength={200} className={INPUT_CLASS} aria-label={t('project_chat.new_team_title', 'Name (optional)')} placeholder={t('project_chat.new_team_title', 'Name (optional)')} />
        <textarea value={message} onChange={e => setMessage(e.target.value)} maxLength={MAX_MESSAGE_LENGTH} rows={3}
            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !isImeEnter(e)) { e.preventDefault(); void submit(); } }}
            aria-label={t('project_chat.new_message_label', 'First message')} placeholder={t('project_chat.project_prompt', 'Share an update, discuss an idea, or mention @AI for help…')} className={`${INPUT_CLASS} resize-y`} />
        <div className="flex items-center gap-3"><p className="flex-1 text-xs text-[var(--text-secondary)] m-0">{t('project_chat.shared_ai_hint', 'Everyone in this project can read along. Mention @AI when you want its help.')}</p><PrimaryButton onClick={submit} busy={create.isPending} data-testid="new-chat-submit">{t('project_chat.start_chat', 'Start chat')}</PrimaryButton></div>
        <ErrorText>{error}</ErrorText>
    </section>;
}
