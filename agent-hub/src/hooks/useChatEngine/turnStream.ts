/**
 * Phase 2 of a chat turn: read the SSE response and hand every event to the
 * dispatcher, while keeping the bookkeeping the end of the turn needs (did the
 * stream produce work, did it finish with `done`, which conversation, what
 * was produced).
 */
import { readEventStream } from '../../api/readEventStream';
import { logger } from '../../utils/logger';
import type { ContentFlusher } from './contentFlusher';
import { WORK_EVENT_KINDS, extractMdHeading, type WorkItem } from './workSummary';
import type { SseDispatchIds, SseEventData } from './types';

/** Everything one turn tracks from its first message to its end. */
export interface ChatTurn {
    userMsgId: string;
    assistantMsgId: string;
    /** The message streamed into right now (a sub-agent can take over). */
    activeIdRef: { current: string };
    /** The streamed text, ahead of what the flusher committed. */
    contentRef: { current: string };
    flusher: ContentFlusher;
    /**
     * Last work item ({ kind, title }) seen on this stream, so the
     * interrupted/error notices can say WHAT was produced (BFSF-221).
     */
    workRef: { current: WorkItem | null };
    /**
     * The stream produced real work (content/tool/build events) before it
     * ended, so a drop AFTER work was in flight (e.g. a long webpage/notebook
     * build that tripped a proxy idle-timeout) isn't misreported as a hard
     * failure (BFSF-221).
     */
    producedWork: boolean;
    /**
     * The server sent its terminal `done` event: the turn completed and was
     * persisted. Anything that fails after this is teardown noise (a socket
     * the server never closed cleanly, a proxy reset) and must NOT be shown as
     * "interrupted": the answer on screen is the whole answer.
     */
    sawDone: boolean;
    conversationId: string | undefined;
    /** ISO time the memory chip asks "what did this turn save since". */
    startedAt: string;
}

/** Events that represent real progress (see `ChatTurn.producedWork`). */
const WORK_EVENTS = new Set([
    'content', 'content_replace', 'tool_start', 'tool_end',
    'webpage_doc_update', 'webpage_doc_partial', 'webpage_extra_update',
    'workspace_update', 'notebook_doc_update', 'slides_deck_update',
    'sheet_update', 'image', 'calendar_draft', 'linkedin_draft',
    'document_update',
]);

export interface TurnStreamHandlers {
    /** The SSE dispatcher (handleSSEEventRef.current). */
    dispatch: (event: string, data: SseEventData, ids: SseDispatchIds) => void;
    isDirectMode: boolean;
    /** Direct chats report a created/renamed conversation to the page. */
    onDirectConversation?: (info: { conversationId?: string; title?: string }) => void;
}

/**
 * Capture WHAT was produced (kind + best-known title) so the interrupted/error
 * notices can name it. Latest event wins; a titleless follow-up of the same
 * kind keeps the earlier title.
 */
function noteWorkItem(turn: ChatTurn, event: string, data: SseEventData): void {
    const kind = WORK_EVENT_KINDS[event];
    if (!kind) return;
    const prev = turn.workRef.current;
    const title = data.title
        || (event === 'workspace_update' ? extractMdHeading(data.content) : null)
        || (prev?.kind === kind ? prev.title : null);
    turn.workRef.current = { kind, title };
}

/** Book-keep one event on the turn, then dispatch it. */
export function applyTurnEvent(turn: ChatTurn, event: string, data: SseEventData, handlers: TurnStreamHandlers): void {
    if (WORK_EVENTS.has(event)) turn.producedWork = true;
    if (event === 'done') turn.sawDone = true;
    if ((event === 'done' || event === 'conversation_created') && typeof data.conversationId === 'string') {
        turn.conversationId = data.conversationId;
    }
    noteWorkItem(turn, event, data);

    // Direct-chat specific events.
    if (handlers.isDirectMode) {
        if (event === 'conversation_created' && data.conversationId) {
            handlers.onDirectConversation?.({ conversationId: data.conversationId });
        } else if (event === 'title' && data.title) {
            handlers.onDirectConversation?.({ conversationId: data.conversationId, title: data.title });
        }
    }

    handlers.dispatch(event, data, {
        assistantMsgId: turn.assistantMsgId,
        userMsgId: turn.userMsgId,
        activeIdRef: turn.activeIdRef,
        contentRef: turn.contentRef,
        flusher: turn.flusher,
        workRef: turn.workRef,
    });
}

/**
 * Read the whole response. The reader accepts the spec-legal `data:{…}`
 * without a space and CRLF framing a proxy may introduce, and it flushes a
 * final event that arrived without a trailing newline: the server's terminal
 * `done` can be in the last chunk, and dropping it left the message stuck in
 * isStreaming:true (BFSF-177). A bad line or a throwing handler skips that
 * event only.
 */
export async function readTurnStream(
    response: Response,
    signal: AbortSignal,
    turn: ChatTurn,
    handlers: TurnStreamHandlers,
): Promise<void> {
    const events = readEventStream<SseEventData>(response, {
        signal,
        defaultEvent: '',
        onInvalidData: (event, _raw, err) => logger.debug('[useChatEngine] SSE event parse skipped', event, err),
    });
    for await (const { event, data } of events) {
        try {
            applyTurnEvent(turn, event, data, handlers);
        } catch (e) {
            logger.debug('[useChatEngine] SSE event parse skipped', event, e);
        }
    }
}
