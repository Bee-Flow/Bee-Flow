// One team chat inside a project: people talk to each other, and the AI (or
// the chat's agent) joins when the chat's AI mode says so. Messages are
// stored encrypted with the project key; this view only ever sees them
// through the chat endpoints, which refuse anyone outside the project.

import { useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Lock, Sparkles } from 'lucide-react';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError } from '../../../../api/client';
import {
    discardPendingMessage, newClientMsgId, useLoadOlderMessages, useProjectChatQuery, useSendTeamChatMessage,
    useTeamChatAgents, useTeamChatMessages, useUpdateProjectChat, type PendingTeamChatMessage, type SendTeamChatMessage, type TeamChat,
    type TeamChatAiResult, type TeamChatMessage, type TeamChatRef,
} from '../../../../api/queries/projectChats';
import { useProjectResourcesQuery, type Project, type ProjectRole } from '../../../../api/queries/projects';
import { useTranslation, type TranslateFn } from '../../../../hooks/useTranslation';
import { toast } from '../../../shared/Toast';
import { projectErrorText } from '../projectErrorText';
import { useProjectLive } from '../ProjectLiveContext';
import type { TaskLink } from '../../../../api/queries/projectTasks';
import { useProjectTasksQuery } from '../../../../api/queries/projectTasks';
import type { WorkspaceUser } from '../types';
import { GhostButton, LoadingRow, Notice, SecondaryButton } from '../workspaceUi';
import type { BaseMessageContext } from './ChatMessageList';
import ChatComposer, { type ComposerDraft } from './ChatComposer';
import ChatMessageList from './ChatMessageList';
import ChatSearchBar from './ChatSearchBar';
import { useChatPeople } from './chatPeople';
import type { MentionCandidate } from './mentions';
import { excerptOf } from './messageGroups';
import TeamChatHeader from './TeamChatHeader';
import ThreadPanel from './ThreadPanel';
import TypingIndicator from './TypingIndicator';
import { draftKey } from './drafts';
import { takeFirstAnswer } from './firstAnswer';
import { aiToneFor, projectIcon } from '../projectVisuals';
import useChatSearch from './useChatSearch';
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
    // The notice belongs to where the message was written: the chat, or one thread of it.
    const [notice, setNotice] = useState<{ text: string; threadId: string | null } | null>(null);

    const applyAi = useCallback((ai: TeamChatAiResult, askedAi: boolean, threadId: string | null) => {
        if (ai.status === 'queued') { setAnswering(true); return; }
        const text = aiResultNotice(ai, askedAi, t);
        setNotice(text ? { text, threadId } : null);
    }, [setAnswering, t]);

    const run = useCallback((vars: SendTeamChatMessage) => {
        setNotice(null);
        mutateAsync(vars).then(({ ai }) => applyAi(ai, vars.askAi, vars.threadId ?? null)).catch(() => { /* the message itself shows "not sent" with a retry */ });
    }, [mutateAsync, applyAi]);

    const clearNotice = useCallback(() => setNotice(null), []);
    const retry = useCallback((p: PendingTeamChatMessage) => run({
        clientMsgId: p.clientMsgId, content: p.content, mentions: p.mentions, replyTo: p.replyTo, threadId: p.threadId, refs: p.refs, modelTier: p.modelTier, askAi: p.askAi,
    }), [run]);
    const discard = useCallback((p: PendingTeamChatMessage) => discardPendingMessage(qc, projectId, chat.id, p.clientMsgId), [qc, projectId, chat.id]);
    return {
        notice,
        applyAi,
        clearNotice,
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

const NO_MESSAGES: TeamChatMessage[] = [];

function useNames(projectId: string, chat: TeamChat, currentUser: WorkspaceUser | null, agents: { id: string; name?: string }[]) {
    const { t } = useTranslation();
    const people = useChatPeople(projectId, currentUser);
    const { data: resources } = useProjectResourcesQuery(projectId);
    const { data: taskData } = useProjectTasksQuery(projectId);
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
        // Filed resources and work items can be tagged by name.
        const items: { ref: TeamChatRef; name: string }[] = [];
        for (const [kind, section] of [['document', resources?.documents], ['notebook', resources?.notebooks], ['meeting', resources?.meetings]] as const) {
            for (const it of section || []) {
                // A meeting note is listed by its title, the others by their name.
                const name = typeof it.name === 'string' ? it.name : typeof it.title === 'string' ? it.title : '';
                if (typeof it.id === 'string' && name.trim()) items.push({ ref: { kind, id: it.id }, name: name.trim() });
            }
        }
        const tasks = (taskData?.tasks || []).filter(item => !item.unreadable && item.title.trim());
        const titleCounts = new Map<string, number>();
        for (const item of tasks) titleCounts.set(item.title.toLocaleLowerCase(), (titleCounts.get(item.title.toLocaleLowerCase()) || 0) + 1);
        for (const item of tasks) {
            items.push({ ref: { kind: 'task', id: item.id }, name: item.title });
            candidates.push({ key: `task:${item.id}`, kind: 'task', label: item.title,
                token: titleCounts.get(item.title.toLocaleLowerCase())! > 1 ? `${item.title} (${item.id.slice(0, 6)})` : item.title,
                ref: { kind: 'task', id: item.id } });
        }
        for (const it of items) {
            if (it.ref.kind === 'task') continue;
            candidates.push({ key: `${it.ref.kind}:${it.ref.id}`, kind: it.ref.kind, label: it.name, token: it.name, ref: it.ref });
        }
        const refTitle = (ref: TeamChatRef) => items.find(i => i.ref.kind === ref.kind && i.ref.id === ref.id)?.name || '';
        return { nameOf, avatarOf: people.avatarOf, colorOf: people.colorOf, assistantName, candidates, refTitle, tokens: ['ai', 'assistant', ...candidates.map(c => c.token)] };
    }, [people, currentUser, agents, chat.aiMode, chat.agentId, resources, taskData, t]);
}

/** What the AI said about a message its author sent, with a way to dismiss it. */
function AiNotice({ text, onDismiss }: { text: string | null; onDismiss: () => void }) {
    const { t } = useTranslation();
    if (!text) return null;
    return (
        <div className="flex-shrink-0 px-4 pb-2">
            <Notice icon={Sparkles} tone="warning" role="status"
                action={<GhostButton onClick={onDismiss}>{t('project_chat.dismiss', 'Dismiss')}</GhostButton>}>
                {text}
            </Notice>
        </div>
    );
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
    const { applyAi, clearNotice } = sender;
    const messagesQuery = useTeamChatMessages(projectId, chat.id);
    const allMessages = messagesQuery.data?.messages || NO_MESSAGES;
    const older = useLoadOlderMessages(projectId, chat.id);
    const [searchOpen, setSearchOpen] = useState(false);
    const search = useChatSearch(allMessages);
    const [prefill, setPrefill] = useState<{ text: string; nonce: number } | null>(null);
    const [editRequest, setEditRequest] = useState<{ messageId: string; nonce: number } | null>(null);
    // The unread count only rides along from the chats list (the detail answer never carries it), so keep the one seen at open.
    const [unreadAtOpen] = useState(() => (typeof chat.unread === 'number' ? chat.unread : 0));
    // ArrowUp in an empty composer edits the latest message of your own.
    const onEditLastOwn = useCallback(() => {
        const last = [...allMessages].reverse().find(m => !m.threadId && m.authorKind === 'user' && m.authorUserId === me && !m.deleted);
        if (last) setEditRequest({ messageId: last.id, nonce: Date.now() });
    }, [allMessages, me]);

    // What the AI said about the first message that created this chat (the form that made it is gone).
    useEffect(() => {
        const first = takeFirstAnswer(chat.id);
        if (first) applyAi(first.ai, first.askedAi, null);
    }, [chat.id, applyAi]);
    // An "ask again when it is done" (or any other) notice is about a turn that is over once the AI finishes.
    const wasAnswering = useRef(false);
    useEffect(() => {
        if (wasAnswering.current && !live.ai.answering) clearNotice();
        wasAnswering.current = live.ai.answering;
    }, [live.ai.answering, clearNotice]);

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
        highlight: searchOpen && search.query.trim() ? { query: search.query.trim(), activeMessageId: search.activeId } : undefined,
        editRequest,
    }), [me, role, canPost, chat.archived, chat.id, project?.color, project?.icon, names, sender.retry, sender.discard, onNavigate, onOpenItem, onCreateTask,
        searchOpen, search.query, search.activeId, editRequest]);
    // Inside a thread there is no second thread and no quoting.
    const threadBase = useMemo<BaseMessageContext>(() => ({ ...base, onReply: undefined, onOpenThread: undefined }), [base]);

    const typers = (typing[chat.id] || []).map(id => names.nameOf(id));
    const mainNotice = sender.notice?.threadId ? null : sender.notice?.text || problemNotice(live.ai.problem, t);
    const threadNotice = threadId && sender.notice?.threadId === threadId ? sender.notice.text : null;
    const replyChip = reply ? {
        author: reply.authorKind === 'assistant' ? names.assistantName(reply.agentId) : names.nameOf(reply.authorUserId),
        excerpt: excerptOf(reply.content),
    } : null;

    const dismissNotice = () => { clearNotice(); live.setAnswering(false); };
    const typingLine = <TypingIndicator names={typers} aiAnswering={live.ai.answering} aiName={names.assistantName(chat.agentId)} />;
    const writable = canPost && !chat.archived;
    return (
        <div className="relative h-full flex min-h-0 bg-[var(--bg-primary)]" data-testid="project-team-chat">
            <div className="flex-1 min-w-0 flex flex-col min-h-0">
                <TeamChatHeader projectId={projectId} chat={chat} role={role} currentUserId={me} agents={agents} onBack={onBack} onDeleted={onBack}
                    onCreateTask={onCreateTask ? () => onCreateTask([{ kind: 'chat', id: chat.id }], chat.title || '') : undefined}
                    onToggleSearch={() => setSearchOpen(o => !o)} searchOpen={searchOpen} />
                {searchOpen && (
                    <ChatSearchBar search={search} hasOlder={!!messagesQuery.data?.hasOlder} loadingOlder={older.isPending}
                        onLoadOlder={() => older.mutate(undefined, { onError: () => toast.error(t('project_chat.older_failed', 'Could not load earlier messages.')) })}
                        onClose={() => setSearchOpen(false)} />
                )}
                <ChatMessageList projectId={projectId} chatId={chat.id} base={base} footer={live.threadId ? undefined : typingLine}
                    unreadCount={unreadAtOpen} onStarter={writable ? text => setPrefill({ text, nonce: Date.now() }) : undefined} />
                <AiNotice text={mainNotice} onDismiss={dismissNotice} />
                {writable ? (
                    <ChatComposer draftKey={draftKey(me, chat.id)} candidates={names.candidates} aiEnabled={chat.aiMode !== 'off'} reply={replyChip} tier={tier}
                        onCancelReply={() => setReply(null)} onTyping={() => notifyTyping(chat.id)} onEditLastOwn={onEditLastOwn} prefill={prefill}
                        onSend={(draft) => { sender.submit(draft, reply?.id || null); setReply(null); }} />
                ) : <ReadOnlyBar chat={chat} canEdit={canPost} projectId={projectId} />}
            </div>
            {threadId && (
                <ThreadPanel key={threadId} projectId={projectId} chatId={chat.id} threadId={threadId} base={threadBase} canPost={writable}
                    footer={live.threadId === threadId ? typingLine : undefined} notice={<AiNotice text={threadNotice} onDismiss={dismissNotice} />} onClose={() => setThreadId(null)}
                    onCreateTask={onCreateTask && writable ? () => onCreateTask([{ kind: 'thread', id: threadId, chatId: chat.id }], chat.title || '') : undefined}
                    composer={{
                        candidates: names.candidates, aiEnabled: chat.aiMode !== 'off', tier, onTyping: () => notifyTyping(chat.id),
                        draftKey: draftKey(me, chat.id, threadId),
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
