/**
 * Phase 0 of a chat turn: the user's message and the assistant placeholder go
 * on screen, and the turn's bookkeeping starts.
 */
import type { Dispatch, SetStateAction } from 'react';
import { generateMessageId } from '../../utils/helpers';
import { createContentFlusher } from './contentFlusher';
import type { ChatAttachment } from './historyAttachment';
import type { ChatTurn } from './turnStream';
import type { ChatMessage } from './types';

/** Slack before a turn's start when the chip asks what the turn saved. */
export const MEMORY_SINCE_SLACK_MS = 3000;

export interface TurnTarget {
    /** Registry key: the conversation, else a fresh pending key. */
    streamKey: string;
    chatProjectId: string | null;
    conversationId: string | undefined;
}

/**
 * Where a turn belongs. A chat that belongs to a project uses that project,
 * however it was opened: the project the person is in, else the one the
 * conversation is filed in. The stream is tracked so navigating away detaches
 * instead of killing the answer (see hooks/streamRegistry), keyed by
 * conversation so a remount finds its own stream and a second send
 * supersedes the first.
 */
export function turnTarget(
    currentConversation: { id?: string | null; project_id?: string | null; projectId?: string | null } | null | undefined,
    directMode: { conversationId?: string } | null | undefined,
    activeProject: { id?: string } | null | undefined,
): TurnTarget {
    const chatProjectId = activeProject?.id || currentConversation?.project_id || currentConversation?.projectId || null;
    const conversationId = currentConversation?.id || directMode?.conversationId;
    return { streamKey: conversationId || `pending:${generateMessageId()}`, chatProjectId, conversationId };
}

export interface OpenTurnInput {
    text: string;
    attachments: ChatAttachment[];
    isHidden: boolean;
    isDirectMode: boolean;
    agent?: { id?: string; name?: string; avatar?: string } | null;
    conversationId: string | undefined;
    /** Server clock minus browser clock, as learned from the last turn. */
    serverSkewMs: number;
    setMessages: Dispatch<SetStateAction<ChatMessage[]>>;
}

/**
 * Put the user's message and a streaming placeholder on screen and return the
 * new turn.
 *
 * The memory chip asks the server for what this turn saved "since" a moment.
 * Three seconds of slack cover clock skew between this browser and the
 * server; once the response arrives its `Date` header (whole seconds)
 * corrects the skew (`noteServerClock`), so a badly set clock cannot shift
 * the window.
 */
export function openTurn({ text, attachments, isHidden, isDirectMode, agent, conversationId, serverSkewMs, setMessages }: OpenTurnInput): ChatTurn {
    const turnStartMs = Date.now();
    const userMsgId = generateMessageId();
    const newMessage = {
        id: userMsgId,
        role: 'user',
        content: text,
        attachments,
        timestamp: new Date().toISOString(),
        isHidden,
    };

    // A new turn closes the previous turn's chip window: its polling stops and
    // whatever the server saves from now on belongs to this turn.
    const until = new Date(turnStartMs + serverSkewMs).toISOString();
    setMessages(prev => [...prev.map(m => (m.memoryWatch && !m.memoryWatch.until
        ? { ...m, memoryWatch: { ...m.memoryWatch, until } }
        : m)), newMessage]);

    const assistantMsgId = generateMessageId();
    const placeholder = {
        id: assistantMsgId,
        role: 'assistant',
        content: '',
        isStreaming: true,
        respondingAgentId: isDirectMode ? 'direct' : agent?.id,
        respondingAgentName: isDirectMode ? null : agent?.name,
        respondingAgentAvatar: isDirectMode ? '💬' : agent?.avatar,
    };
    setMessages(prev => [...prev, placeholder]);

    const activeIdRef = { current: assistantMsgId };
    const contentRef = { current: '' };
    return {
        userMsgId,
        assistantMsgId,
        activeIdRef,
        contentRef,
        // Per-stream rAF coalescer for 'content' tokens (see createContentFlusher).
        flusher: createContentFlusher(setMessages, activeIdRef, contentRef),
        workRef: { current: null },
        producedWork: false,
        sawDone: false,
        conversationId,
        startedAt: new Date(turnStartMs - MEMORY_SINCE_SLACK_MS).toISOString(),
    };
}

/**
 * Learn the server clock from the response's `Date` header. Returns the new
 * skew (server minus browser), or null when the header is missing; on a hit
 * the turn's memory window is re-anchored on the server's clock.
 */
export function noteServerClock(response: Response, turn: ChatTurn): number | null {
    const serverNow = Date.parse(response.headers?.get?.('Date') ?? '');
    if (!Number.isFinite(serverNow)) return null;
    // The header has whole-second resolution, so it is at most 1 s behind.
    turn.startedAt = new Date(serverNow - MEMORY_SINCE_SLACK_MS).toISOString();
    return serverNow - Date.now();
}
