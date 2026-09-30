// The live side of team chats, fed by the project page's one feed
// (ProjectLiveContext). The provider already marks every `chats` query stale
// on a chat event; what it cannot know is which ONE message someone edited,
// whether the AI is busy in a chat, or that the open chat was deleted. That
// is what these hooks add.

import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { refreshTeamChatMessage, teamChatKeys } from '../../../../api/queries/projectChats';
import { useProjectLive, type ProjectLiveEvent } from '../ProjectLiveContext';

/** After this long without a "finished" event an AI turn is assumed over. */
export const AI_ANSWER_TIMEOUT_MS = 180_000;

/** The team chat an event is about, or null. */
export function chatIdOfEvent(event: ProjectLiveEvent): string | null {
    const fromPayload = event.payload?.chatId;
    if (typeof fromPayload === 'string' && fromPayload) return fromPayload;
    if (event.targetType === 'project_chat' || event.targetType === 'chat') return event.targetId || null;
    return null;
}

/** Why the last AI turn produced no answer: an error, or privacy protection stopping it. */
export type TeamChatAiProblem = 'failed' | 'blocked' | null;
export interface TeamChatAiState { answering: boolean; problem: TeamChatAiProblem }

const problemOf = (status: unknown): TeamChatAiProblem => (status === 'failed' || status === 'blocked' ? status : null);

interface EventContext {
    qc: QueryClient;
    projectId: string;
    chatId: string;
    setAnswering: (answering: boolean, problem?: TeamChatAiProblem) => void;
    setGone: (gone: boolean) => void;
}

type Handler = (ctx: EventContext, payload: Record<string, unknown>) => void;

const refreshOne: Handler = ({ qc, projectId, chatId }, payload) => {
    const seq = Number(payload.seq);
    refreshTeamChatMessage(qc, projectId, chatId, Number.isFinite(seq) ? seq : null).catch(() => {});
};

const HANDLERS: Record<string, Handler> = {
    'chat.message.created': ({ qc, projectId, chatId, setAnswering }, payload) => {
        if (payload.authorKind === 'assistant') setAnswering(false);
        // Pull what is new; an in-flight sync already does, so do not restart it.
        qc.invalidateQueries({ queryKey: teamChatKeys.messages(projectId, chatId), exact: true }, { cancelRefetch: false });
    },
    'chat.message.updated': refreshOne,
    'chat.message.deleted': refreshOne,
    'chat.ai.started': ({ setAnswering }) => setAnswering(true),
    'chat.ai.finished': ({ setAnswering }, payload) => setAnswering(false, problemOf(payload.status)),
    'chat.deleted': ({ setGone }) => setGone(true),
    'chat.updated': ({ qc, projectId, chatId }) => {
        qc.invalidateQueries({ queryKey: teamChatKeys.detail(projectId, chatId), exact: true });
    },
};

/** Live state of one open team chat. */
export function useTeamChatLive(projectId: string, chatId: string) {
    const qc = useQueryClient();
    const { subscribe } = useProjectLive();
    const [ai, setAi] = useState<TeamChatAiState>({ answering: false, problem: null });
    const [gone, setGone] = useState(false);
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

    const setAnswering = useCallback((answering: boolean, problem: TeamChatAiProblem = null) => {
        if (timer.current) clearTimeout(timer.current);
        timer.current = answering ? setTimeout(() => setAi({ answering: false, problem: null }), AI_ANSWER_TIMEOUT_MS) : null;
        setAi({ answering, problem });
    }, []);

    useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

    useEffect(() => subscribe((kind, event) => {
        const handler = HANDLERS[kind];
        if (!handler || chatIdOfEvent(event) !== chatId) return;
        handler({ qc, projectId, chatId, setAnswering, setGone }, event.payload || {});
    }), [subscribe, qc, projectId, chatId, setAnswering]);

    return { ai, gone, setAnswering };
}

const STARTS = new Set(['chat.ai.started', 'run.started']);
const ENDS = new Set(['chat.ai.finished', 'run.finished']);

/** Ids of the team chats and shared AI chats the AI is answering in right now. */
export function useAnsweringIds(): ReadonlySet<string> {
    const { subscribe } = useProjectLive();
    const [started, setStarted] = useState<ReadonlyMap<string, number>>(new Map());

    useEffect(() => subscribe((kind, event) => {
        if (!STARTS.has(kind) && !ENDS.has(kind)) return;
        const id = kind.startsWith('chat.') ? chatIdOfEvent(event) : (event.targetId || event.conversationId || null);
        if (!id) return;
        setStarted((prev) => {
            const next = new Map(prev);
            if (STARTS.has(kind)) next.set(String(id), Date.now());
            else next.delete(String(id));
            return next;
        });
    }), [subscribe]);

    const [now, setNow] = useState(() => Date.now());
    useEffect(() => {
        if (!started.size) return undefined;
        const tick = setInterval(() => setNow(Date.now()), 30_000);
        return () => clearInterval(tick);
    }, [started]);

    const live = new Set<string>();
    for (const [id, at] of started) if (now - at < AI_ANSWER_TIMEOUT_MS || at > now) live.add(id);
    return live;
}
