// One project conversation: members and AI work in the same place.
import { MessageSquare, Send, Users } from 'lucide-react';
import React, { useState } from 'react';
import type { Project, ProjectRole } from '../../../api/queries/projects';
import { useCreateProjectChat } from '../../../api/queries/projectChats';
import useTranslation from '../../../hooks/useTranslation';
import { rememberFirstAnswer } from './chat/firstAnswer';
import { isImeEnter } from './chat/ime';
import { projectErrorText } from './projectErrorText';
import { canEditProject, type StartChat } from './types';
import { ErrorText, PrimaryButton } from './workspaceUi';

export const MAX_FIRST_MESSAGE = 20000;
export default function ProjectComposer({ project, role, readOnly = false, onOpenTeamChat }: {
    project: Project; role: ProjectRole; onStartChat: StartChat; onOpenTeamChat: (chatId: string) => void;
    /** The project is archived: nothing can be started. */
    readOnly?: boolean;
}) {
    const { t } = useTranslation();
    const [text, setText] = useState('');
    const [error, setError] = useState<string | null>(null);
    const create = useCreateProjectChat(project.id);
    const ready = !!text.trim() && !create.isPending;
    const submit = async () => {
        if (!ready) return;
        setError(null);
        try {
            const res = await create.mutateAsync({ aiMode: 'mention', message: text.trim() });
            if (!res?.chat?.id) throw new Error(t('project_chat.create_failed', 'Could not start the chat.'));
            rememberFirstAnswer(res.chat.id, res.ai, text.trim());
            setText('');
            onOpenTeamChat(res.chat.id);
        } catch (e) { setError(projectErrorText(t, e)); }
    };
    if (project.kind === 'solution') return <p data-testid="composer-solution">{t('project_home.composer.solution', 'A Studio Solution holds no chats. Start chats in a project.')}</p>;
    if (readOnly) return <p className="text-sm text-[var(--text-secondary)]" data-testid="composer-archived">{t('project_home.archived.read_only', 'This project is archived and read-only. Restore it to change anything.')}</p>;
    if (!canEditProject(role)) return <p className="text-sm text-[var(--text-secondary)]" data-testid="composer-readonly">{t('project_home.composer.readonly', 'You can read everything in this project. Ask the owner for editor access to start chats and add work.')}</p>;
    return <section className="rounded-2xl border border-[var(--border-default)] bg-[var(--bg-card)] shadow-sm overflow-hidden" data-testid="project-composer">
        <div className="px-5 pt-5 flex items-center gap-2 text-[var(--text-primary)] font-semibold"><MessageSquare className="w-5 h-5" aria-hidden="true" />{t('project_chat.start_together', 'Start a conversation')}</div>
        <textarea value={text} onChange={e => setText(e.target.value)} maxLength={MAX_FIRST_MESSAGE} rows={3}
            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !isImeEnter(e)) { e.preventDefault(); void submit(); } }}
            aria-label={t('project_home.composer.label', 'First message')}
            placeholder={t('project_chat.project_prompt', 'Share an update, discuss an idea, or mention @AI for help…')}
            className="w-full resize-none bg-transparent px-5 py-4 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] outline-none"
            data-testid="composer-input" />
        <div className="flex items-center gap-3 px-5 pb-4">
            <p className="flex-1 text-xs text-[var(--text-secondary)] m-0 flex items-start gap-2"><Users className="w-4 h-4 shrink-0" aria-hidden="true" />{t('project_chat.shared_ai_hint', 'Everyone in this project can read along. Mention @AI when you want its help.')}</p>
            <PrimaryButton onClick={submit} disabled={!ready} busy={create.isPending} data-testid="composer-send"><Send className="w-4 h-4" aria-hidden="true" />{t('project_chat.start_chat', 'Start chat')}</PrimaryButton>
        </div>
        {error && <div className="px-5 pb-4"><ErrorText testId="composer-error">{error}</ErrorText></div>}
    </section>;
}
