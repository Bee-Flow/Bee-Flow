// One team chat inside a project: people talk to each other, and the AI (or
// the chat's agent) joins when the chat's AI mode says so. Messages are
// stored encrypted with the project key; this view only ever sees them
// through the chat endpoints, which refuse anyone outside the project.

import { useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Lock, Sparkles } from 'lucide-react';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError } from '../../../../api/client';
import {
    discardPendingMessage, newClientMsgId, newestSeq, useMarkTeamChatRead, useProjectChatQuery, useSendTeamChatMessage,
    useTeamChatAgents, useTeamChatMessages, useUpdateProjectChat, type PendingTeamChatMessage, type SendTeamChatMessage, type TeamChat,
    type TeamChatAiResult, type TeamChatMessage, type TeamChatRef,
} from '../../../../api/queries/projectChats';
import { useProjectResourcesQuery, type Project, type ProjectRole } from '../../../../api/queries/projects';
import { useTranslation, type TranslateFn } from '../../../../hooks/useTranslation';
import { toast } from '../../../shared/Toast';
import { projectErrorText } from '../projectErrorText';
import { useProjectLive } from '../ProjectLiveContext';
import type { TaskLink } from '../../../../api/queries/projectTasks';
import type { WorkspaceUser } from '../types';
import { GhostButton, LoadingRow, Notice, SecondaryButton } from '../workspaceUi';
import type { BaseMessageContext } from './ChatMessageList';
import ChatComposer, { type ComposerDraft } from './ChatComposer';
import ChatMessageList from './ChatMessageList';
import { useChatPeople } from './chatPeople';
import type { MentionCandidate } from './mentions';
import { excerptOf } from './messageGroups';
import TeamChatHeader from './TeamChatHeader';
import ThreadPanel from './ThreadPanel';
import TypingIndicator from './TypingIndicator';
import { aiToneFor, projectIcon } from '../projectVisuals';
import { useChatTier } from './useChatTier';
import { useTeamChatLive, type TeamChatAiProblem } from './useTeamChatLive';

export interface ProjectTeamChatProps {
    projectId: string;
    project?: Project;
    role: ProjectRole;
    currentUser: WorkspaceUser | null;
    chatId: string;
    onBack: () => void;
    /** The app's navigation, for the link to one's own AI settings. */
    onNavigate?: (page: string) => void;
    /** Opens a tagged document or notebook. */
    onOpenItem?: (ref: TeamChatRef) => void;
    /** Opens the task form with these links (the chat, or a thread of it) and a title to start from. */
    onCreateTask?: (links: TaskLink[], title: string, description?: string) => void;
    /** A thread to open with the chat (a task's link to a thread). */
    initialThreadId?: string | null;
}

/** Keep the server's read marker at the newest message while the chat is on screen. */
function useMarkRead(projectId: string, chatId: string) {
    const { data } = useTeamChatMessages(projectId, chatId);
    const { mutate } = useMarkTeamChatRead(projectId, chatId);
    const marked = useRef(0);
    const [visible, setVisible] = useState(() => typeof document === 'undefined' || document.visibilityState !== 'hidden');
    const seq = newestSeq(data?.messages || []);
    useEffect(() => {
        const onChange = () => setVisible(document.visibilityState !== 'hidden');
        document.addEventListener('visibilitychange', onChange);
        return () => document.removeEventListener('visibilitychange', onChange);
    }, []);
    useEffect(() => {
        if (!visible || !seq || seq <= marked.current) return;
        marked.current = seq;
        mutate(seq);
    }, [visible, seq, mutate]);
}

/** What to tell the author when the AI will not answer their message, if anything. */
export function aiResultNotice(ai: TeamChatAiResult, askedAi: boolean, t: TranslateFn): string | null {
    if (ai.status === 'busy') return t('project_chat.ai_busy', 'The AI is still answering an earlier message. Ask again when it is done.');
    if (ai.status !== 'skipped') return null;
    if (ai.reason === 'limit') return t('project_chat.ai_limit', 'The AI did not answer: the AI usage limit has been reached.');
    if (ai.reason === 'unavailable' || ai.reason === 'no_model') return t('project_chat.ai_unavailable', 'The AI is not available right now, so it did not answer.');
    if (ai.reason === 'ai_off' && askedAi) return t('project_chat.ai_off_notice', 'The AI is off in this chat. Turn it on at the top to ask it something.');
    if (ai.reason === 'ai_mode_not_allowed') return t('project_chat.ai_mode_withdrawn_notice', 'Your organisation no longer lets the AI answer every message here. Mention @ai to ask it.');
    return null;
}

/** Send, resend and discard, and what the AI said about the message. */
function useSender(projectId: string, chat: TeamChat, currentUserId: string | null, setAnswering: (on: boolean) => void) {
    const { t } = useTranslation();
    const qc = useQueryClient();
    const { mutateAsync } = useSendTeamChatMessage(projectId, chat.id, currentUserId);
    const [notice, setNotice] = useState<string | null>(null);

    const run = useCallback((vars: SendTeamChatMessage) => {
        setNotice(null);
        mutateAsync(vars).then(({ ai }) => {
            if (ai.status === 'queued') setAnswering(true);
            else setNotice(aiResultNotice(ai, vars.askAi, t));
        }).catch(() => { /* the message itself shows "not sent" with a retry */ });
    }, [mutateAsync, setAnswering, t]);

    const retry = useCallback((p: PendingTeamChatMessage) => run({
        clientMsgId: p.clientMsgId, content: p.content, mentions: p.mentions, replyTo: p.replyTo, threadId: p.threadId, refs: p.refs, modelTier: p.modelTier, askAi: p.askAi,
    }), [run]);
    const discard = useCallback((p: PendingTeamChatMessage) => discardPendingMessage(qc, projectId, chat.id, p.clientMsgId), [qc, projectId, chat.id]);
    return {
        notice,
        clearNotice: () => setNotice(null),
        submit: (draft: ComposerDraft, replyTo: string | null, threadId: string | null = null) => run({ clientMsgId: newClientMsgId(), ...draft, replyTo, threadId }),
        retry,
        discard,
    };
}

function problemNotice(problem: TeamChatAiProblem, t: TranslateFn): string | null {
    if (problem === 'blocked') return t('project_chat.ai_blocked', 'Privacy protection stopped the AI from answering this message.');
    if (problem === 'failed') return t('project_chat.ai_failed', 'The AI could not answer. Try asking again.');
    return null;
}

function useNames(projectId: string, chat: TeamChat, currentUser: WorkspaceUser | null, agents: { id: string; name?: string }[]) {
    const { t } = useTranslation();
    const people = useChatPeople(projectId, currentUser);
    const { data: resources } = useProjectResourcesQuery(projectId);
    return useMemo(() => {
        const nameOf = (id: string | null | undefined) => people.nameOf(id)
            || (id && id === currentUser?.id ? t('project_chat.you', 'You') : t('project_chat.someone', 'A member'));
        const assistantName = (agentId: string | null | undefined) => (agentId
            ? agents.find(a => a.id === agentId)?.name || t('project_chat.agent_fallback', 'Agent')
            : t('project_chat.ai_assistant', 'AI assistant'));
        const candidates: MentionCandidate[] = people.people
            .filter(p => p.id !== currentUser?.id)
            .map(p => ({ key: p.id, kind: 'user', label: p.name, token: p.name, userId: p.id, picture: p.avatar }));
        if (chat.aiMode !== 'off') {
            candidates.push({ key: 'ai', kind: 'ai', label: t('project_chat.ai_assistant', 'AI assistant'), token: 'ai' });
            const agentName = chat.agentId ? agents.find(a => a.id === chat.agentId)?.name : null;
            if (agentName) candidates.push({ key: `agent:${chat.agentId}`, kind: 'agent', label: agentName, token: agentName });
        }
        // Documents and notebooks filed in the project can be tagged by name.
        const items: { ref: TeamChatRef; name: string }[] = [];
        for (const [kind, section] of [['document', resources?.documents], ['notebook', resources?.notebooks], ['meeting', resources?.meetings]] as const) {
            for (const it of section || []) {
                // A meeting note is listed by its title, the others by their name.
                const name = typeof it.name === 'string' ? it.name : typeof it.title === 'string' ? it.title : '';
                if (typeof it.id === 'string' && name.trim()) items.push({ ref: { kind, id: it.id }, name: name.trim() });
            }
        }
        for (const it of items) {
            candidates.push({ key: `${it.ref.kind}:${it.ref.id}`, kind: it.ref.kind, label: it.name, token: it.name, ref: it.ref });
        }
        const refTitle = (ref: TeamChatRef) => items.find(i => i.ref.kind === ref.kind && i.ref.id === ref.id)?.name || '';
        return { nameOf, avatarOf: people.avatarOf, colorOf: people.colorOf, assistantName, candidates, refTitle, tokens: ['ai', 'assistant', ...candidates.map(c => c.token)] };
    }, [people, currentUser, agents, chat.aiMode, chat.agentId, resources, t]);
}

function ReadOnlyBar({ chat, canEdit, projectId }: { chat: TeamChat; canEdit: boolean; projectId: string }) {
    const { t } = useTranslation();
    const update = useUpdateProjectChat(projectId, chat.id);
    const restore = canEdit && chat.archived
        ? <SecondaryButton busy={update.isPending} onClick={() => update.mutate({ archived: false }, { onError: e => toast.error(projectErrorText(t, e)) })}>
            {t('project_chat.unarchive', 'Restore from archive')}
        </SecondaryButton>
        : null;
    return (
        <div className="flex-shrink-0 px-4 pb-4" data-testid="team-chat-readonly">
            <Notice icon={Lock} action={restore}>
                {chat.archived
                    ? t('project_chat.archived_notice', 'This chat is archived. Restore it to post again.')
                    : t('project_chat.viewer_notice', 'You can read this chat. Only editors can post in it.')}
            </Notice>
        </div>
    );
}

function TeamChatView({ chat, projectId, project, role, currentUser, onBack, onNavigate, onOpenItem, onCreateTask, initialThreadId, live }: ProjectTeamChatProps & {
    chat: TeamChat;
    live: ReturnType<typeof useTeamChatLive>;
}) {
    const { t } = useTranslation();
    const me = currentUser?.id || null;
    const canPost = role === 'owner' || role === 'editor';
    const { data: agents = [] } = useTeamChatAgents(projectId, canPost);
    const names = useNames(projectId, chat, currentUser, agents);
    const { typing, notifyTyping } = useProjectLive();
    const sender = useSender(projectId, chat, me, live.setAnswering);
    const [reply, setReply] = useState<TeamChatMessage | null>(null);
    const [threadId, setThreadId] = useState<string | null>(initialThreadId ?? null);
    const tier = useChatTier();
    useMarkRead(projectId, chat.id);

    const base = useMemo<BaseMessageContext>(() => ({
        currentUserId: me, isProjectOwner: role === 'owner', canPost: canPost && !chat.archived,
        nameOf: names.nameOf, avatarOf: names.avatarOf, colorOf: names.colorOf, assistantName: names.assistantName, mentionTokens: names.tokens,
        onReply: setReply, onOpenThread: (m) => setThreadId(m.id),
        onCreateTask: onCreateTask ? (m) => onCreateTask(
            [m.threadId ? { kind: 'thread', id: m.threadId, chatId: chat.id } : { kind: 'chat', id: chat.id }],
            excerptOf(m.content, 120), m.content,
        ) : undefined, refTitle: names.refTitle, onOpenRef: onOpenItem,
        aiTone: aiToneFor(project?.color), aiIcon: project ? projectIcon(project.icon) : undefined, onRetry: sender.retry, onDiscard: sender.discard,
        onShowAiSettings: onNavigate ? () => onNavigate('settings/preferences') : undefined,
    }), [me, role, canPost, chat.archived, chat.id, project?.color, project?.icon, names, sender.retry, sender.discard, onNavigate, onOpenItem, onCreateTask]);
    // Inside a thread there is no second thread and no quoting.
    const threadBase = useMemo<BaseMessageContext>(() => ({ ...base, onReply: undefined, onOpenThread: undefined }), [base]);

    const typers = (typing[chat.id] || []).map(id => names.nameOf(id));
    const notice = sender.notice || problemNotice(live.ai.problem, t);
    const replyChip = reply ? {
        author: reply.authorKind === 'assistant' ? names.assistantName(reply.agentId) : names.nameOf(reply.authorUserId),
        excerpt: excerptOf(reply.content),
    } : null;

    const typingLine = <TypingIndicator names={typers} aiAnswering={live.ai.answering} aiName={names.assistantName(chat.agentId)} />;
    const writable = canPost && !chat.archived;
    return (
        <div className="relative h-full flex min-h-0 bg-[var(--bg-primary)]" data-testid="project-team-chat">
            <div className="flex-1 min-w-0 flex flex-col min-h-0">
                <TeamChatHeader projectId={projectId} chat={chat} role={role} currentUserId={me} agents={agents} onBack={onBack} onDeleted={onBack}
                    onCreateTask={onCreateTask ? () => onCreateTask([{ kind: 'chat', id: chat.id }], chat.title || '') : undefined} />
                <ChatMessageList projectId={projectId} chatId={chat.id} base={base} footer={threadId ? undefined : typingLine} />
                {notice && (
                    <div className="flex-shrink-0 px-4 pb-2">
                        <Notice icon={Sparkles} tone="warning" role="status"
                            action={<GhostButton onClick={() => { sender.clearNotice(); live.setAnswering(false); }}>{t('project_chat.dismiss', 'Dismiss')}</GhostButton>}>
                            {notice}
                        </Notice>
                    </div>
                )}
                {writable ? (
                    <ChatComposer candidates={names.candidates} aiEnabled={chat.aiMode !== 'off'} reply={replyChip} tier={tier}
                        onCancelReply={() => setReply(null)} onTyping={() => notifyTyping(chat.id)}
                        onSend={(draft) => { sender.submit(draft, reply?.id || null); setReply(null); }} />
                ) : <ReadOnlyBar chat={chat} canEdit={canPost} projectId={projectId} />}
            </div>
            {threadId && (
                <ThreadPanel key={threadId} projectId={projectId} chatId={chat.id} threadId={threadId} base={threadBase} canPost={writable}
                    footer={typingLine} onClose={() => setThreadId(null)}
                    onCreateTask={onCreateTask && writable ? () => onCreateTask([{ kind: 'thread', id: threadId, chatId: chat.id }], chat.title || '') : undefined}
                    composer={{
                        candidates: names.candidates, aiEnabled: chat.aiMode !== 'off', tier, onTyping: () => notifyTyping(chat.id),
                        onSend: (draft) => sender.submit(draft, null, threadId),
                    }} />
            )}
        </div>
    );
}

function Unavailable({ error, onBack, onRetry }: { error: Error | null; onBack: () => void; onRetry?: () => void }) {
    const { t } = useTranslation();
    const missing = !error || (error instanceof ApiError && (error.status === 404 || error.status === 403));
    return (
        <div className="p-6 max-w-xl" data-testid="team-chat-unavailable">
            <Notice tone="warning" icon={AlertTriangle} role="alert"
                action={<div className="flex gap-2">
                    {!missing && onRetry && <GhostButton onClick={onRetry}>{t('project_chat.retry', 'Try again')}</GhostButton>}
                    <SecondaryButton onClick={onBack}>{t('project_chat.back_to_chats', 'Back to chats')}</SecondaryButton>
                </div>}>
                {missing
                    ? t('project_chat.chat_gone', 'This chat was deleted, or you no longer have access to it.')
                    : t('project_chat.chat_failed', 'Could not load this chat.')}
            </Notice>
        </div>
    );
}

export default function ProjectTeamChat(props: ProjectTeamChatProps) {
    const { t } = useTranslation();
    const query = useProjectChatQuery(props.projectId, props.chatId);
    const live = useTeamChatLive(props.projectId, props.chatId);
    if (live.gone) return <Unavailable error={null} onBack={props.onBack} />;
    if (!query.data) {
        return query.isError
            ? <Unavailable error={query.error} onBack={props.onBack} onRetry={() => query.refetch()} />
            : <LoadingRow label={t('project_chat.loading_chat', 'Loading chat…')} />;
    }
    return <TeamChatView {...props} chat={query.data} live={live} />;
}
