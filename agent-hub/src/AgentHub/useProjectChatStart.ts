import { useMutation, useQueryClient } from '@tanstack/react-query';
import { type RefObject, useCallback, useEffect, useRef, useState } from 'react';
import { apiClient } from '../api/client';
import { projectKeys, type Project } from '../api/queries/projects';
import { toast } from '../components/shared/Toast';
import type { TranslateFn } from '../hooks/useTranslation';

/**
 * "Start a chat in this project", from the project's composer.
 *
 * Opening the chat and sending the first message cannot happen in one go: the
 * chat engine reads the project, the mode and the agent from state, so the
 * message may only be sent once those have been rendered. A start therefore
 * moves through three phases, tracked per start in a ref:
 *
 *   opening  the project is the chat context and a new direct or agent chat
 *            has been asked for; the message is sent as soon as that chat is
 *            on screen and empty.
 *   sent     the first turn is running. Once it has finished, and only if the
 *            person asked for it, the new conversation is shared into the
 *            project.
 *   done     nothing left to do.
 *
 * SHARING IS THE PRIVACY-SENSITIVE HALF. It re-encrypts a conversation with
 * the project key and shows it to every member, so it must hit exactly the
 * conversation this start created and nothing else. That id is PINNED: it is
 * the first conversation the chat engine reports for this start's turn
 * (`turnConversation`, set when the server says which conversation the turn
 * wrote to), never whatever id happens to be on screen. The id on screen can
 * belong to an older chat the person opened while the turn ran, and that chat
 * may even start with the same sentence. So a share needs all three: the chat
 * on screen is still the one that was opened (same mode, same agent), its
 * first message is the one that was sent, AND its id is the pinned one. If
 * any of them fails, nothing is shared and the person is told so; they can
 * share the chat themselves from its menu. The share waits for the turn to
 * finish so it never re-encrypts rows the running turn is still writing.
 *
 * A message is never dropped silently: if the chat could not be opened or the
 * turn never started, it goes back into the composer.
 */

export interface StartChatRequest {
    project: Project;
    message: string;
    agentId?: string | null;
    share?: boolean;
}

type ChatType = 'direct' | 'agent';

interface PendingStart {
    token: number;
    projectId: string;
    projectName: string;
    message: string;
    type: ChatType;
    agentId: string | null;
    share: boolean;
}

interface Progress {
    token: number;
    phase: 'opening' | 'sent' | 'done';
    /** The message list as it was when the turn was sent: a new list is the
     *  sign the chat engine accepted the turn. */
    messagesAtSend: unknown;
    /** The engine's last report when the turn was sent: only a newer report
     *  can name the conversation this start created. */
    reportAtSend: TurnConversation | null;
    /** The conversation this start's turn created, once the engine said so. */
    createdId: string | null;
}

/**
 * The conversation the chat engine's latest turn wrote to, as the server
 * reported it (a direct chat's `conversation_created`, an agent turn's
 * `done`). A new object per report, so every report can be told apart.
 */
export interface TurnConversation {
    type: ChatType;
    id: string;
}

interface ChatMessageLike {
    role?: string;
    content?: unknown;
    isHidden?: boolean;
}

/** What the chat view looks like right now. */
export interface ChatViewState {
    activeProjectId: string | null;
    isLoading: boolean;
    directChatMode: boolean;
    selectedAgentId: string | null;
    directConversationId: string | null;
    agentConversationId: string | null;
    messages: ChatMessageLike[];
    /** The engine's latest report of the conversation a turn wrote to. */
    turnConversation?: TurnConversation | null;
}

export interface ProjectChatStartDeps<TAgent extends { id: string }> extends ChatViewState {
    t: TranslateFn;
    agents: TAgent[];
    /** Makes the project the chat context. */
    setActiveProject: (project: Project) => void;
    /** Leaves the projects pages for the chat view. */
    leaveProjectsPage: () => void;
    openDirectChat: () => void;
    openAgentChat: (agent: TAgent) => void;
    sendMessage: (text: string) => unknown;
    setChatInput: (text: string) => void;
    /** How long the chat may take to open before the start is given up. */
    openTimeoutMs?: number;
}

const OPEN_TIMEOUT_MS = 10_000;

function notSharedText(t: TranslateFn): string {
    return t('sidebar.project_chat_not_shared', 'The chat was not shared with the project. You can still share it from its menu in the chat list.');
}

interface ShareVars { projectId: string; projectName: string; conversationId: string; type: ChatType }

function useShareNewChat(t: TranslateFn) {
    const qc = useQueryClient();
    return useMutation<void, Error, ShareVars>({
        mutationFn: async ({ projectId, conversationId, type }) => {
            await apiClient.post(
                `/api/projects/${encodeURIComponent(projectId)}/threads`,
                { conversationId, type },
                { retry: false },
            );
        },
        onSuccess: (_data, vars) => {
            qc.invalidateQueries({ queryKey: projectKeys.threads(vars.projectId) });
            qc.invalidateQueries({ queryKey: projectKeys.myChats(vars.projectId) });
            toast.success(t('sidebar.project_chat_shared', 'Chat shared with the members of {name}.', { name: vars.projectName }));
        },
        // The server's reason (a missing project key, a role that changed
        // meanwhile) is not something the person can act on here; the
        // sentence says what happened, and the chat itself is safe.
        onError: () => {
            toast.error(t('sidebar.project_chat_share_failed', 'The chat was saved in the project, but it could not be shared with its members.'));
        },
    });
}

/** The new, empty chat this start asked for is on screen, in its project. */
export function isChatReady(start: PendingStart, view: ChatViewState): boolean {
    if (view.isLoading || view.activeProjectId !== start.projectId) return false;
    return start.type === 'direct'
        ? view.directChatMode && !view.selectedAgentId && !view.directConversationId
        : view.selectedAgentId === start.agentId && !view.agentConversationId;
}

export type StartOutcome =
    | { kind: 'give-back' }
    | { kind: 'done' }
    | { kind: 'not-shared' }
    | { kind: 'share'; conversationId: string };

/**
 * What to do once the first turn is over. Pure, so the rule that decides
 * whether a conversation may be shared can be read (and tested) on its own.
 * `createdId` is the conversation the engine reported for this start's turn;
 * without it, or when the chat on screen is another one, nothing is shared.
 */
export function decideOutcome(
    start: Pick<PendingStart, 'type' | 'agentId' | 'message' | 'share'>,
    view: ChatViewState,
    createdId: string | null,
): StartOutcome {
    const inView = start.type === 'direct'
        ? view.directChatMode && !view.selectedAgentId
        : view.selectedAgentId === start.agentId;
    const conversationId = start.type === 'direct' ? view.directConversationId : view.agentConversationId;
    const first = view.messages.find(m => m?.role === 'user' && !m.isHidden);
    const started = !!first && first.content === start.message;
    if (!started) {
        // Still on the new, empty chat: the composer refused the turn.
        if (inView && !conversationId && view.messages.length === 0) return { kind: 'give-back' };
        return start.share ? { kind: 'not-shared' } : { kind: 'done' };
    }
    if (!start.share) return { kind: 'done' };
    if (!inView || !conversationId || conversationId !== createdId) return { kind: 'not-shared' };
    return { kind: 'share', conversationId };
}

/** The first report after the send, of this start's chat type, names the
 *  conversation the start created. Later reports never replace it. */
function pinCreated(progress: Progress, type: ChatType, report: TurnConversation | null | undefined): void {
    if (progress.createdId || !report || report === progress.reportAtSend || report.type !== type) return;
    progress.createdId = report.id;
}

/** Gives the message back when the chat never opened, or the turn was never
 *  taken up by the chat engine. */
function useStartWatchdog(
    pending: PendingStart | null,
    progressRef: RefObject<Progress | null>,
    messagesRef: RefObject<unknown>,
    giveBack: (start: PendingStart) => void,
    timeoutMs: number,
) {
    useEffect(() => {
        if (!pending) return undefined;
        const timer = setTimeout(() => {
            const progress = progressRef.current;
            if (!progress || progress.token !== pending.token) return;
            const stuck = progress.phase === 'opening'
                || (progress.phase === 'sent' && messagesRef.current === progress.messagesAtSend);
            if (!stuck) return;
            progress.phase = 'done';
            giveBack(pending);
        }, timeoutMs);
        return () => clearTimeout(timer);
    }, [pending, progressRef, messagesRef, giveBack, timeoutMs]);
}

export default function useProjectChatStart<TAgent extends { id: string }>(deps: ProjectChatStartDeps<TAgent>) {
    const {
        t, agents, setActiveProject, leaveProjectsPage, openDirectChat, openAgentChat,
        sendMessage, setChatInput, openTimeoutMs = OPEN_TIMEOUT_MS,
    } = deps;
    const { activeProjectId, isLoading, directChatMode, selectedAgentId, directConversationId, agentConversationId, messages } = deps;
    const turnConversation = deps.turnConversation ?? null;
    const [pending, setPending] = useState<PendingStart | null>(null);
    const progressRef = useRef<Progress | null>(null);
    const messagesRef = useRef<unknown>(messages);
    const tokenRef = useRef(0);
    const { mutate: share } = useShareNewChat(t);

    const giveBack = useCallback((start: PendingStart) => {
        setChatInput(start.message);
        toast.error(t('sidebar.project_chat_not_started', 'The chat could not be started. Your message is back in the composer.'));
    }, [setChatInput, t]);

    const startChat = useCallback((request: StartChatRequest): boolean => {
        const message = typeof request?.message === 'string' ? request.message.trim() : '';
        const project = request?.project;
        if (!project?.id || !message) return false;
        const agent = request.agentId ? agents.find(a => a.id === request.agentId) : undefined;
        // Checked before anything moves: an agent this person cannot use must
        // not leave them on an empty chat with their message gone.
        if (request.agentId && !agent) {
            toast.error(t('sidebar.project_agent_unavailable', 'That agent is not available to you, so the chat was not started.'));
            return false;
        }
        setActiveProject(project);
        leaveProjectsPage();
        if (agent) openAgentChat(agent);
        else openDirectChat();
        tokenRef.current += 1;
        progressRef.current = { token: tokenRef.current, phase: 'opening', messagesAtSend: null, reportAtSend: null, createdId: null };
        setPending({
            token: tokenRef.current,
            projectId: project.id,
            projectName: project.name || '',
            message,
            type: agent ? 'agent' : 'direct',
            agentId: agent ? agent.id : null,
            share: !!request.share,
        });
        return true;
    }, [agents, setActiveProject, leaveProjectsPage, openAgentChat, openDirectChat, t]);

    useEffect(() => { messagesRef.current = messages; }, [messages]);
    useStartWatchdog(pending, progressRef, messagesRef, giveBack, openTimeoutMs);

    useEffect(() => {
        const progress = progressRef.current;
        if (!pending || !progress || progress.token !== pending.token || progress.phase === 'done') return;
        const view = { activeProjectId, isLoading, directChatMode, selectedAgentId, directConversationId, agentConversationId, messages };
        if (progress.phase === 'opening') {
            if (!isChatReady(pending, view)) return;
            progress.phase = 'sent';
            progress.messagesAtSend = messages;
            progress.reportAtSend = turnConversation;
            sendMessage(pending.message);
            return;
        }
        pinCreated(progress, pending.type, turnConversation);
        // Wait for the engine to take the turn up (a new message list) and
        // for the turn to finish.
        if (isLoading || messages === progress.messagesAtSend) return;
        progress.phase = 'done';
        const outcome = decideOutcome(pending, view, progress.createdId);
        if (outcome.kind === 'give-back') giveBack(pending);
        else if (outcome.kind === 'not-shared') toast.info(notSharedText(t));
        else if (outcome.kind === 'share') {
            share({ projectId: pending.projectId, projectName: pending.projectName, conversationId: outcome.conversationId, type: pending.type });
        }
    }, [pending, activeProjectId, isLoading, directChatMode, selectedAgentId, directConversationId, agentConversationId, messages, turnConversation, sendMessage, giveBack, share, t]);

    return { startChat };
}
