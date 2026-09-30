// The form "New chat" opens at the top of the Chats tab. A team chat is made
// here (and opened); an AI or agent chat is handed to the app, which opens
// the chat view in this project and, when asked, shares it with the members.

import { Bot, Sparkles, Users, X } from 'lucide-react';
import React, { useEffect, useRef, useState } from 'react';
import { useCreateProjectChat, useTeamChatAiPolicy, type TeamChatAiMode } from '../../../../api/queries/projectChats';
import type { Project } from '../../../../api/queries/projects';
import { useTranslation } from '../../../../hooks/useTranslation';
import SegmentedControl from '../../../shared/SegmentedControl';
import { useUsableAgents } from '../homeQueries';
import { projectErrorText } from '../projectErrorText';
import type { StartChat } from '../types';
import { ErrorText, INPUT_CLASS, PrimaryButton, SELECT_CLASS } from '../workspaceUi';
import AiModeSelector from './AiModeSelector';
import { MAX_MESSAGE_LENGTH } from './ChatComposer';

export type NewChatMode = 'team' | 'ai' | 'agent';

export interface NewChatComposerProps {
    mode: NewChatMode;
    project: Project;
    onModeChange: (mode: NewChatMode) => void;
    onClose: () => void;
    onStartChat: StartChat;
    onOpenTeamChat: (chatId: string) => void;
}

function useStart(props: NewChatComposerProps) {
    const { t } = useTranslation();
    const create = useCreateProjectChat(props.project.id);
    const [error, setError] = useState<string | null>(null);
    const start = async (form: { message: string; title: string; aiMode: TeamChatAiMode; agentId: string; share: boolean }) => {
        setError(null);
        if (props.mode !== 'team') {
            const started = props.onStartChat({
                project: props.project, message: form.message.trim(), share: form.share,
                agentId: props.mode === 'agent' ? form.agentId : null,
            });
            // Refused (the app said why): the form, and the message, stay.
            if (started === true) props.onClose();
            return;
        }
        try {
            const { chat } = await create.mutateAsync({ title: form.title, aiMode: form.aiMode, message: form.message });
            props.onOpenTeamChat(chat.id);
        } catch (e) {
            setError(projectErrorText(t, e, t('project_chat.create_failed', 'Could not start the team chat.')));
        }
    };
    return { start, error, busy: create.isPending };
}

function ModeSwitch({ mode, onChange }: { mode: NewChatMode; onChange: (m: NewChatMode) => void }) {
    const { t } = useTranslation();
    return (
        <SegmentedControl
            size="sm"
            value={mode}
            onChange={onChange}
            ariaLabel={t('project_chat.new_chat_kind', 'Kind of chat')}
            options={[
                { value: 'team', label: t('project_chat.new_team', 'Team chat'), icon: <Users className="w-3.5 h-3.5" aria-hidden="true" /> },
                { value: 'ai', label: t('project_chat.new_ai', 'AI chat'), icon: <Sparkles className="w-3.5 h-3.5" aria-hidden="true" /> },
                { value: 'agent', label: t('project_chat.new_agent', 'Agent chat'), icon: <Bot className="w-3.5 h-3.5" aria-hidden="true" /> },
            ]}
        />
    );
}

function ShareToggle({ share, onChange }: { share: boolean; onChange: (v: boolean) => void }) {
    const { t } = useTranslation();
    return (
        <label className="inline-flex items-center gap-2 text-[12.5px] text-[var(--text-secondary)] cursor-pointer">
            <input type="checkbox" checked={share} onChange={e => onChange(e.target.checked)} className="accent-[var(--accent-primary)]" />
            {t('project_chat.share_on_start', 'Share with project members')}
        </label>
    );
}

export default function NewChatComposer(props: NewChatComposerProps) {
    const { t } = useTranslation();
    const { mode, onModeChange, onClose } = props;
    const [message, setMessage] = useState('');
    const [title, setTitle] = useState('');
    const [aiMode, setAiMode] = useState<TeamChatAiMode>('mention');
    const [agentId, setAgentId] = useState('');
    const [share, setShare] = useState(false);
    const agents = useUsableAgents(mode === 'agent');
    const policy = useTeamChatAiPolicy(props.project.id);
    const { start, error, busy } = useStart(props);
    const inputRef = useRef<HTMLTextAreaElement>(null);
    useEffect(() => { inputRef.current?.focus(); }, [mode]);

    const ready = mode === 'team' || (!!message.trim() && (mode !== 'agent' || !!agentId));
    const submit = () => { if (ready && !busy) start({ message, title, aiMode, agentId, share }); };
    const placeholder = mode === 'team'
        ? t('project_chat.new_team_placeholder', 'First message to the team (optional)')
        : t('project_chat.new_ai_placeholder', 'What do you want to ask?');

    return (
        <section className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-card)] px-3.5 py-3 space-y-3" data-testid="new-chat-composer"
            aria-label={t('project_chat.new_chat', 'New chat')}>
            <div className="flex items-center justify-between gap-2">
                <ModeSwitch mode={mode} onChange={onModeChange} />
                <button type="button" onClick={onClose} aria-label={t('project_chat.close', 'Close')}
                    className="grid place-items-center w-7 h-7 rounded-md text-[var(--text-tertiary)] hover:bg-[var(--item-hover-bg)] hover:text-[var(--text-primary)]">
                    <X className="w-4 h-4" aria-hidden="true" />
                </button>
            </div>
            {mode === 'team' && (
                <input value={title} onChange={e => setTitle(e.target.value)} maxLength={200} className={INPUT_CLASS}
                    aria-label={t('project_chat.new_team_title', 'Name (optional)')} placeholder={t('project_chat.new_team_title', 'Name (optional)')} />
            )}
            {mode === 'agent' && (
                <select value={agentId} onChange={e => setAgentId(e.target.value)} className={`${SELECT_CLASS} w-full`}
                    aria-label={t('project_chat.pick_agent', 'Agent')}>
                    <option value="">{agents.isPending ? t('project_chat.agents_loading', 'Loading agents…') : t('project_chat.pick_agent_prompt', 'Choose an agent')}</option>
                    {(agents.data || []).map(a => <option key={a.id} value={a.id}>{a.name || a.id}</option>)}
                </select>
            )}
            <textarea ref={inputRef} value={message} onChange={e => setMessage(e.target.value)} maxLength={MAX_MESSAGE_LENGTH} rows={3}
                onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); submit(); } }}
                aria-label={t('project_chat.new_message_label', 'First message')} placeholder={placeholder} className={`${INPUT_CLASS} resize-y`} />
            <div className="flex items-center gap-3 flex-wrap">
                {mode === 'team'
                    ? <AiModeSelector value={aiMode} onChange={setAiMode} policy={policy} />
                    : <ShareToggle share={share} onChange={setShare} />}
                <span className="flex-1" />
                <PrimaryButton onClick={submit} disabled={!ready} busy={busy} data-testid="new-chat-submit">
                    {mode === 'team' ? t('project_chat.start_team', 'Start team chat') : t('project_chat.start_chat', 'Start chat')}
                </PrimaryButton>
            </div>
            <ErrorText>{error}</ErrorText>
        </section>
    );
}
