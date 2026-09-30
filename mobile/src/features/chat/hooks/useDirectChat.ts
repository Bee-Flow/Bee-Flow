/**
 * One direct-chat conversation: its persisted transcript, the local turns
 * layered over it, the stream, and the ways a turn starts (the composer, a
 * draft handed over by the home screen, a retry, an edit).
 *
 * `id` is either a conversation id or the literal `new`. Routing a new chat
 * through the same screen means the move from "empty" to "has an id" is a
 * state change instead of a navigation — so the first answer is not
 * interrupted by a screen swap, which is exactly when it would be most
 * annoying.
 */

import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';

import { useActiveSkills } from '@/features/skills';
import { useTurn } from '@/shared/stream';

import { invalidateAfterTurn } from './mutations';
import { useConversation } from './queries';
import { useChatStream } from './useChatStream';
import { useDraftOnce } from './useDraftOnce';
import { useTitleCatchUp } from './useTitleCatchUp';
import { useTranscriptTurns } from './useTranscriptTurns';
import { endedEarly } from '../model/answer';
import { currentMediaPayload } from '../model/mediaSettings';
import { unsavedFailure } from '../model/retry';
import { awaitsTitle } from '../model/titleCatchUp';
import type { FinishedTurn } from '../model/transcript';
import { directTurnPayload } from '../model/turnPayload';
import type { ComposerSettings } from '../model/types';

export interface DirectChatOptions {
    id: string | undefined;
    /** A message to send once, on mount, into a new chat (with any files the home composer staged). */
    draft?: string;
    settings: ComposerSettings;
    memoryEnabled: boolean;
    /** A project a NEW chat starts in; a saved one says its own. */
    project?: string;
}

export function useDirectChat({ id, draft, settings, memoryEnabled, project }: DirectChatOptions) {
    const isNew = !id || id === 'new';
    const queryClient = useQueryClient();
    const { activeSkillIds } = useActiveSkills();
    const [conversationId, setConversationId] = useState<string | null>(isNew ? null : (id ?? null));
    const query = useConversation(conversationId);
    const settleRef = useRef<((finished: FinishedTurn, interrupted: boolean) => void) | null>(null);
    const catchUpTitle = useTitleCatchUp();

    const stream = useChatStream({
        onDone: (finished) => {
            // The server assigns the id on the first turn of a new chat, on
            // `conversation_created` or `done` — both at the end of the turn.
            const savedId = finished.conversationId ?? conversationId;
            if (finished.conversationId && !conversationId) setConversationId(finished.conversationId);
            // A turn the server never finished (Stop, a socket closed before
            // `done`) keeps its words and is marked, and outlives the refetch.
            settleRef.current?.(finished, endedEarly(finished));
            invalidateAfterTurn(queryClient, finished.conversationId);
            // The chat's name is made after `done`, when the stream is closed.
            if (savedId && finished.completed && awaitsTitle(query.data?.title)) catchUpTitle(savedId);
        },
        onUnhandled: (event) => {
            // Not a crash — the server grew a feature this client does not
            // draw yet. Visible in dev, silent in release.
            if (__DEV__) console.warn(`[chat] unhandled SSE event: ${event}`);
        },
    });

    // The project the chat is filed in travels with every turn, as the web's
    // active project does: the server reads that project's context with it.
    const projectId = query.data?.project_id ?? project ?? null;

    // A failed or stopped last turn survives the server catching up: it was
    // not saved, and the refetch would take it — and its "Try again" — away.
    const turns = useTranscriptTurns({
        persisted: query.data?.messages,
        persistedAt: query.dataUpdatedAt,
        streaming: stream.streaming,
        keep: unsavedFailure,
        reset: stream.reset,
        start: ({ text, attachments, turn, options }) =>
            stream.send(
                directTurnPayload({
                    text,
                    attachments,
                    conversationId,
                    settings,
                    history: turn.history,
                    historyOverride: turn.historyOverride,
                    memoryEnabled,
                    activeSkillIds,
                    projectId,
                    tierOverride: options.tierOverride,
                    media: currentMediaPayload(),
                }),
            ),
    });
    useEffect(() => {
        settleRef.current = turns.settle;
    });
    useDraftOnce(draft, isNew, turns.handleSend);

    // The server could not open this conversation's history with this
    // session's key: nothing it answers can be saved, so the composer locks.
    const locked = useTurn(stream.store, (turn) => turn.historyLocked);

    return {
        isNew,
        conversationId,
        query,
        stream,
        locked,
        messages: turns.messages,
        conversation: turns.conversation,
        handleSend: turns.handleSend,
        handleRetry: turns.handleRetry,
        handleEdit: turns.handleEdit,
    };
}
