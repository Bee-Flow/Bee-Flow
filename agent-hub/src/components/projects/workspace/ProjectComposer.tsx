// The overview's composer: the one box that starts work in a project.
//
//   AI assistant  a chat with the AI that knows the project (instructions,
//                 knowledge); private unless "Share with members" is on
//   Agent         the same, with one of the caller's agents
//   Team          a team chat every member sees; the AI answers on @mention
//
// AI and agent chats open in the app's chat view (onStartChat); a team chat
// is created here and opened in the Chats tab.

import { Bot, Send, Sparkles, Users } from 'lucide-react';
import React, { useState } from 'react';
import type { Project, ProjectRole } from '../../../api/queries/projects';
import { useCreateProjectChat } from '../../../api/queries/projectChats';
import useTranslation from '../../../hooks/useTranslation';
import SegmentedControl from '../../shared/SegmentedControl';
import Toggle from '../../shared/Toggle';
import { useUsableAgents } from './homeQueries';
import { projectErrorText } from './projectErrorText';
import { canEditProject, type StartChat } from './types';
import { ErrorText, PrimaryButton, SELECT_CLASS } from './workspaceUi';

export type ComposerMode = 'ai' | 'agent' | 'team';

export const MAX_FIRST_MESSAGE = 20000;

function AgentPicker({ value, onChange }: { value: string; onChange: (id: string) => void }) {
    const { t } = useTranslation();
    const agents = useUsableAgents(true);
    if (agents.isError) return <ErrorText>{t('project_home.composer.agents_failed', 'Could not load your agents.')}</ErrorText>;
    if (agents.isSuccess && agents.data.length === 0) {
        return <p className="text-xs text-[var(--text-tertiary)] m-0">{t('project_home.composer.no_agents', 'You have no agents to chat with yet.')}</p>;
    }
    return (
        <select
            value={value}
            onChange={(e) => onChange(e.target.value)}
            disabled={agents.isPending}
            aria-label={t('project_home.composer.agent', 'Agent')}
            className={`${SELECT_CLASS} max-w-[16rem]`}
            data-testid="composer-agent"
        >
            <option value="">{agents.isPending ? t('project_home.loading', 'Loading…') : t('project_home.composer.pick_agent', 'Choose an agent…')}</option>
            {(agents.data || []).map((a) => <option key={a.id} value={a.id}>{a.name || a.id}</option>)}
        </select>
    );
}

function ShareToggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
    const { t } = useTranslation();
    return (
        <div className="flex items-center gap-2">
            <Toggle size="sm" checked={checked} onChange={onChange} ariaLabel={t('project_home.composer.share', 'Share with members')} />
            <span className="text-[12px] text-[var(--text-secondary)]" aria-hidden="true">{t('project_home.composer.share', 'Share with members')}</span>
        </div>
    );
}

function useModeOptions() {
    const { t } = useTranslation();
    return [
        { value: 'ai' as ComposerMode, label: t('project_home.composer.mode_ai', 'AI assistant'), icon: <Sparkles className="w-3.5 h-3.5" aria-hidden="true" /> },
        { value: 'agent' as ComposerMode, label: t('project_home.composer.mode_agent', 'Agent'), icon: <Bot className="w-3.5 h-3.5" aria-hidden="true" /> },
        { value: 'team' as ComposerMode, label: t('project_home.composer.mode_team', 'Team'), icon: <Users className="w-3.5 h-3.5" aria-hidden="true" /> },
    ];
}

function modeHint(mode: ComposerMode, share: boolean, t: ReturnType<typeof useTranslation>['t']): string {
    if (mode === 'team') return t('project_home.composer.hint_team', 'Everyone in the project sees this chat. Mention @AI when you want an answer from the AI.');
    const who = share
        ? t('project_home.composer.hint_shared', 'Members can read along.')
        : t('project_home.composer.hint_private', 'Only you see this chat.');
    if (mode === 'agent') return `${t('project_home.composer.hint_agent', 'Chat with one of your agents, with this project’s instructions and knowledge.')} ${who}`;
    return `${t('project_home.composer.hint_ai', 'The AI knows this project’s instructions and knowledge.')} ${who}`;
}

function useComposerSend(project: Project, onStartChat: StartChat, onOpenTeamChat: (chatId: string) => void) {
    const { t } = useTranslation();
    const createChat = useCreateProjectChat(project.id);
    const [error, setError] = useState<string | null>(null);

    const send = async (mode: ComposerMode, message: string, agentId: string, share: boolean): Promise<boolean> => {
        setError(null);
        // A refused start keeps the text in the box: the app said why.
        if (mode !== 'team') return onStartChat({ project, message, agentId: mode === 'agent' ? agentId : null, share }) === true;
        try {
            const res = await createChat.mutateAsync({ aiMode: 'mention', message });
            const chatId = res?.chat?.id;
            if (!chatId) throw new Error(t('project_home.composer.team_failed', 'Could not start the team chat.'));
            onOpenTeamChat(chatId);
            return true;
        } catch (e) {
            setError(projectErrorText(t, e, t('project_home.composer.team_failed', 'Could not start the team chat.')));
            return false;
        }
    };
    return { send, error, busy: createChat.isPending };
}

export default function ProjectComposer({ project, role, onStartChat, onOpenTeamChat }: {
    project: Project;
    role: ProjectRole;
    onStartChat: StartChat;
    onOpenTeamChat: (chatId: string) => void;
}) {
    const { t } = useTranslation();
    const [text, setText] = useState('');
    const [mode, setMode] = useState<ComposerMode>('ai');
    const [agentId, setAgentId] = useState('');
    const [share, setShare] = useState(false);
    const modeOptions = useModeOptions();
    const { send, error, busy } = useComposerSend(project, onStartChat, onOpenTeamChat);
    const message = text.trim();
    const ready = !!message && !busy && (mode !== 'agent' || !!agentId);

    // A Studio Solution holds no chats: the server would refuse a team chat,
    // and an AI chat started here would not be filed in it.
    if (project.kind === 'solution') {
        return (
            <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-card)] px-4 py-3 text-[13px] text-[var(--text-tertiary)]" data-testid="composer-solution">
                {t('project_home.composer.solution', 'A Studio Solution holds no chats. Start chats in a project.')}
            </div>
        );
    }

    if (!canEditProject(role)) {
        return (
            <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-card)] px-4 py-3 text-[13px] text-[var(--text-tertiary)]" data-testid="composer-readonly">
                {t('project_home.composer.readonly', 'You can read everything in this project. Ask the owner for editor access to start chats and add work.')}
            </div>
        );
    }

    const submit = async () => {
        if (!ready) return;
        if (await send(mode, message, agentId, share)) setText('');
    };

    return (
        <div className="rounded-xl border border-[var(--border-default)] bg-[var(--bg-card)] shadow-sm" data-testid="project-composer">
            <textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); submit(); }
                }}
                maxLength={MAX_FIRST_MESSAGE}
                rows={3}
                aria-label={t('project_home.composer.label', 'First message')}
                placeholder={mode === 'team'
                    ? t('project_home.composer.placeholder_team', 'Write to everyone in {name}…', { name: project.name })
                    : t('project_home.composer.placeholder', 'Start a chat in {name}…', { name: project.name })}
                className="w-full resize-none bg-transparent px-4 pt-3 pb-1 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] outline-none"
                data-testid="composer-input"
            />
            <div className="flex items-center gap-2 flex-wrap px-3 pb-3">
                <SegmentedControl size="sm" value={mode} onChange={setMode} options={modeOptions} ariaLabel={t('project_home.composer.mode', 'Chat type')} />
                {mode === 'agent' && <AgentPicker value={agentId} onChange={setAgentId} />}
                {mode !== 'team' && <ShareToggle checked={share} onChange={setShare} />}
                <div className="flex-1" />
                <PrimaryButton onClick={submit} disabled={!ready} busy={busy} data-testid="composer-send">
                    <Send className="w-3.5 h-3.5" aria-hidden="true" />
                    {t('project_home.composer.send', 'Start')}
                </PrimaryButton>
            </div>
            <div className="px-4 pb-3 space-y-1">
                <p className="text-[11.5px] text-[var(--text-tertiary)] m-0">{modeHint(mode, share, t)}</p>
                <ErrorText testId="composer-error">{error}</ErrorText>
            </div>
        </div>
    );
}
