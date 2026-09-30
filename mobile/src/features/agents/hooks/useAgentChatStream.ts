/**
 * The streaming turn, for an agent.
 *
 * Same runner as direct chat (shared/stream), with the agent adapter
 * (AGENT_FRAMES) and two differences that are in the wire format rather than
 * the UI:
 *
 *   1. A different endpoint: `POST /agents/:id/chat/stream`, with `agentId`
 *      and `stream: true` in the body.
 *
 *   2. A 403 is a first-class outcome, not an error. Access is re-validated
 *      against the DATABASE on every single send
 *      (`userCanAccessPublishedAgent`, server/routes/agents/chat.js), so a
 *      group membership revoked ten seconds ago fails the next message on a
 *      list that still shows the agent. That has to read as "you no longer
 *      have access to this agent", not as "the connection dropped".
 *
 * After every turn the agent's conversation lists and this conversation are
 * refetched: the server is the source of truth for what was stored.
 */

import { useQueryClient } from '@tanstack/react-query';

import { ApiError } from '@/core/api/client';
import { dlpResolverFor, type DlpResolver } from '@/features/chat';
import {
    AGENT_FRAMES,
    describeTurnFailure,
    emptyAgentTurn,
    useTurnStream,
    type AgentTurn,
    type TurnSource,
} from '@/shared/stream';

import { invalidateAfterAgentTurn } from './mutations';
import type { AgentTurnPayload } from '../model/types';

export type { AgentTurn } from '@/shared/stream';

export interface UseAgentChatStreamOptions {
    agentId: string;
    /** Runs before the turn's queries are invalidated. */
    onDone?: (turn: AgentTurn) => void;
    /** Fired for any SSE event this hook does not model. */
    onUnhandled?: (event: string, data: unknown) => void;
}

export interface UseAgentChatStream {
    /** The live turn. Select the fields you draw with `useTurn`. */
    store: TurnSource<AgentTurn>;
    streaming: boolean;
    send: (payload: Omit<AgentTurnPayload, 'agentId' | 'stream'>) => Promise<void>;
    /** Stop the turn. The server aborts the model call when the socket closes. */
    stop: () => void;
    reset: () => void;
    /**
     * Answer a blocked data-loss-prevention prompt. Until this is called the
     * server holds the turn open and nothing further arrives on the stream.
     */
    resolveDlp: DlpResolver;
}

/** How a stream that failed before or during the turn reads on an agent. */
export function agentFailure(turn: AgentTurn, err: unknown): void {
    if (err instanceof ApiError && (err.status === 403 || err.status === 401)) {
        // Access was revoked between opening the agent and sending. The stream
        // never started, so this is the ONLY place it can surface — there is
        // no `error` frame to fold.
        turn.accessDenied = true;
        return;
    }
    // Every other failure reads as on any stream (describeError's words, not
    // err.message): a quota refusal reaching the user as "HTTP 402" is a
    // support ticket for a non-problem.
    turn.error = describeTurnFailure(err);
}

export function useAgentChatStream({
    agentId,
    onDone,
    onUnhandled,
}: UseAgentChatStreamOptions): UseAgentChatStream {
    const queryClient = useQueryClient();
    const stream = useTurnStream<AgentTurn>({
        empty: emptyAgentTurn,
        adapter: AGENT_FRAMES,
        onDone: (turn) => {
            onDone?.(turn);
            invalidateAfterAgentTurn(queryClient, agentId, turn.conversationId);
        },
        onUnhandled,
        onFailure: agentFailure,
    });
    const resolveDlp = dlpResolverFor(stream);

    const send = (payload: Omit<AgentTurnPayload, 'agentId' | 'stream'>) => {
        const body: AgentTurnPayload = { ...payload, agentId, stream: true };
        return stream.run(`/agents/${encodeURIComponent(agentId)}/chat/stream`, body, {
            conversationId: payload.conversationId ?? null,
        });
    };

    return {
        store: stream.store,
        streaming: stream.streaming,
        send,
        stop: stream.stop,
        reset: stream.reset,
        resolveDlp,
    };
}
