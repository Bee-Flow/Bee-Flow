/**
 * Phase 3 of a chat turn: how it ends. A completed turn, a refused one, a
 * stream that ended without `done` or threw, and the recovery poll that swaps
 * the persisted reply in after a drop.
 */
import type { Dispatch, SetStateAction } from 'react';
import { logger } from '../../utils/logger';
import type { TranslateFn } from '../useTranslation';
import { summarizeWorkItem } from './workSummary';
import type { ChatTurn } from './turnStream';
import type { ChatMessage } from './types';

/** The hook state a turn's end writes to, and what it reads at that moment. */
export interface TurnEndDeps {
    setMessages: Dispatch<SetStateAction<ChatMessage[]>>;
    setIsLoading: (loading: boolean) => void;
    /** Current translator (tRef.current at call time). */
    t: () => TranslateFn;
    /** Current conversation (messagesRef.current at call time). */
    messages: () => ChatMessage[];
    /** Current recovery loader (reloadConversationRef.current at call time). */
    reloadConversation: () => (() => Promise<ChatMessage[] | null | undefined>) | undefined;
}

/** Quick first attempt, then every 4 s up to ~60 s in total. */
export const RECOVERY_DELAYS_MS = [1200, 4000, 4000, 4000, 4000, 4000, 4000, 4000, 4000, 4000, 4000, 4000, 4000, 4000];

function patchMessage(deps: TurnEndDeps, id: string, patch: (m: ChatMessage) => ChatMessage): void {
    deps.setMessages(prev => prev.map(m => (m.id === id ? patch(m) : m)));
}

/** Permissions were revoked while the user had the agent open: say so plainly. */
export function finishPermissionDenied(turn: ChatTurn, deps: TurnEndDeps): void {
    patchMessage(deps, turn.assistantMsgId, m => ({
        ...m,
        isStreaming: false,
        isError: true,
        isPermissionDenied: true,
        content: "⚠️ **Access denied** — you no longer have permission to use this agent. Please refresh the page.",
    }));
    deps.setIsLoading(false);
}

/** The turn ended with `done`: close the message, with the memory chip's watch if any. */
function finishCompleted(turn: ChatTurn, deps: TurnEndDeps, memoryWatch: ChatMessage['memoryWatch']): void {
    deps.setIsLoading(false);
    patchMessage(deps, turn.assistantMsgId, m => ({ ...m, isStreaming: false, ...(memoryWatch ? { memoryWatch } : {}) }));
}

export interface MemoryWatchInput {
    /** Only the main chat passes this; it answers why memory is locked, if it is. */
    getMemoryLock?: (() => unknown) | null;
    isTestChat: boolean;
    customEndpoint?: string;
    memoryWriteEnabled: () => boolean;
}

/**
 * Watch for memories this turn saved, unless it could not have saved any:
 * writing was off, memory is locked, or it is a test chat.
 */
export function turnMemoryWatch(turn: ChatTurn, input: MemoryWatchInput): ChatMessage['memoryWatch'] {
    const canWatch = !!input.getMemoryLock && !input.isTestChat
        && !input.customEndpoint
        && !!turn.conversationId
        && input.memoryWriteEnabled()
        && input.getMemoryLock() === null;
    return canWatch ? { conversationId: turn.conversationId as string, since: turn.startedAt } : null;
}

/** The turn already finished on the server: close quietly, no notice on a complete answer. */
function finishAfterDone(turn: ChatTurn, deps: TurnEndDeps): void {
    patchMessage(deps, turn.assistantMsgId, m => ({ ...m, isStreaming: false }));
    deps.setIsLoading(false);
}

/** The message after a stream that ended without completing the turn. */
function abnormalEnd(m: ChatMessage, turn: ChatTurn, interrupted: boolean, t: TranslateFn): ChatMessage {
    // An explicit terminal event already told the user what happened (a
    // server `error`, or a privacy-shield block). Those carry a specific,
    // actionable reason; replacing it with a generic "interrupted"/"Error
    // generating response." would be strictly less true. Just close it out.
    if (m.isError) return { ...m, isStreaming: false };
    if (!interrupted) return { ...m, isStreaming: false, isError: true, content: 'Error generating response.' };
    const prior = (m.content && m.content.trim()) ? m.content.trimEnd() + '\n\n' : '';
    // When we know WHAT was produced, lead with an explicit success
    // confirmation so users don't retry and duplicate.
    const wi = turn.workRef.current;
    const summary = summarizeWorkItem(t, wi);
    const notice = summary
        ? t('chat.interrupted_with_work', { workSummary: summary })
        : t('chat.interrupted_generic');
    return { ...m, isStreaming: false, isInterrupted: true, workItem: wi || null, content: prior + notice };
}

/**
 * Auto-recover: the server persists the finished reply even when the SSE
 * connection drops mid/post-stream (the saved message appears on a manual
 * refresh). Poll the persisted conversation and swap the real reply in so the
 * user doesn't have to refresh. Bounded (~60 s); bails if the user moved on;
 * the interrupted notice stays if recovery never yields a saved reply.
 */
export async function recoverPersistedReply(
    assistantMsgId: string,
    reload: () => Promise<ChatMessage[] | null | undefined>,
    deps: Pick<TurnEndDeps, 'setMessages' | 'messages'>,
): Promise<void> {
    const stillOurs = () => {
        const c = deps.messages();
        const l = c[c.length - 1];
        return !!(l && l.id === assistantMsgId && l.isInterrupted);
    };
    for (const d of RECOVERY_DELAYS_MS) {
        await new Promise(r => setTimeout(r, d));
        if (!stillOurs()) return;
        let reloaded;
        try { reloaded = await reload(); } catch { continue; }
        if (!Array.isArray(reloaded) || reloaded.length === 0) continue;
        const lastReload = reloaded[reloaded.length - 1];
        if (lastReload && lastReload.role === 'assistant' && String(lastReload.content || '').trim()) {
            if (stillOurs()) deps.setMessages(reloaded);
            return;
        }
    }
}

/**
 * The stream ended without completing the turn: it threw, or it reached EOF
 * with no terminal `done`. Both mean the same thing to the user, so they get
 * the same treatment, and a truncated stream can never be finalised as if it
 * had succeeded.
 *
 * If the stream already produced content/tool/build activity, it most likely
 * dropped after the work was underway (e.g. a long webpage/notebook build that
 * tripped a proxy idle-timeout) and the result may well have been saved:
 * surface a non-fatal "interrupted" notice instead of a hard failure
 * (BFSF-221), and start the recovery poll.
 */
export function finishAbnormally(turn: ChatTurn, deps: TurnEndDeps): void {
    const interrupted = turn.producedWork || !!turn.contentRef.current?.trim();
    patchMessage(deps, turn.assistantMsgId, m => abnormalEnd(m, turn, interrupted, deps.t()));
    deps.setIsLoading(false);

    const reload = deps.reloadConversation();
    if (interrupted && typeof reload === 'function') {
        void recoverPersistedReply(turn.assistantMsgId, reload, deps);
    }
}

/**
 * The body ended. Flush the last buffered tokens, then decide: a stream that
 * ends without the server's terminal `done` was CUT, not completed, and
 * reader.read() cannot tell us that. The connector frames SSE with
 * `Connection: close` and no Content-Length (nextcloud-connector/src/proxy.js),
 * so a stream truncated at byte 0 arrives as a successful 200 with an empty
 * body; finalising that silently left a blank assistant bubble with no error
 * anywhere. `done` is the only end-of-turn marker we control, so its absence
 * gets the same interrupted/error handling (and recovery poll) a thrown
 * stream gets.
 */
export function finishStreamEnd(turn: ChatTurn, deps: TurnEndDeps, memory: MemoryWatchInput): void {
    turn.flusher.flushNow();
    if (!turn.sawDone) {
        console.warn('[useChatEngine] stream ended without a terminal `done` event — treating as interrupted');
        finishAbnormally(turn, deps);
    } else {
        finishCompleted(turn, deps, turnMemoryWatch(turn, memory));
    }
}

/** The stream threw. An abort is the user's own stop and ends silently. */
export function finishWithError(e: unknown, turn: ChatTurn, deps: TurnEndDeps): void {
    const err = e instanceof Error ? e : new Error(String(e));
    // Commit buffered tokens before the interrupt/error branch reads
    // m.content, so the prior content prepended to the notice is complete.
    turn.flusher.flushNow();
    if (err.name === 'AbortError') return;
    if (turn.sawDone) {
        logger.debug('[useChatEngine] stream teardown after done', err);
        finishAfterDone(turn, deps);
    } else {
        console.error("Chat error", err);
        finishAbnormally(turn, deps);
    }
}
