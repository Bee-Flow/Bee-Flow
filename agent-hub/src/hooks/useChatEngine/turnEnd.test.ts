// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SetStateAction } from 'react';
import {
    HttpTurnError, httpTurnErrorFrom, finishAbnormally, finishStreamEnd, finishWithError, recoverPersistedReply, turnMemoryWatch,
    RECOVERY_DELAYS_MS, type TurnEndDeps,
} from './turnEnd';
import type { ChatTurn } from './turnStream';
import type { ChatMessage } from './types';

const newTurn = (extra: Partial<ChatTurn> = {}): ChatTurn => ({
    userMsgId: 'u1',
    assistantMsgId: 'a1',
    activeIdRef: { current: 'a1' },
    contentRef: { current: '' },
    flusher: { schedule: vi.fn(), flushNow: vi.fn(), cancel: vi.fn() },
    workRef: { current: null },
    producedWork: false,
    sawDone: false,
    conversationId: undefined,
    startedAt: '2026-01-01T00:00:00.000Z',
    ...extra,
});

/** Deps over a plain array, applying updaters synchronously. */
function harness(initial: ChatMessage[], reload?: () => Promise<ChatMessage[] | null | undefined>) {
    const state = { messages: initial, loading: true };
    const deps: TurnEndDeps = {
        setMessages: (u: SetStateAction<ChatMessage[]>) => { state.messages = typeof u === 'function' ? u(state.messages) : u; },
        setIsLoading: (l: boolean) => { state.loading = l; },
        t: () => ((key: string) => key) as never,
        messages: () => state.messages,
        reloadConversation: () => reload,
    };
    return { state, deps };
}

const streaming = (content = ''): ChatMessage => ({ id: 'a1', role: 'assistant', content, isStreaming: true });

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('finishAbnormally', () => {
    it('is a hard error when nothing was produced', () => {
        const { state, deps } = harness([streaming()]);
        finishAbnormally(newTurn(), deps);
        expect(state.messages[0]).toMatchObject({ isStreaming: false, isError: true, content: 'chat.error.generic' });
        expect(state.loading).toBe(false);
    });

    it('appends an interrupted notice after produced content', () => {
        const { state, deps } = harness([streaming('Half an answer  ')]);
        finishAbnormally(newTurn({ contentRef: { current: 'Half an answer' } }), deps);
        expect(state.messages[0]).toMatchObject({ isInterrupted: true, workItem: null, content: 'Half an answer\n\nchat.interrupted_generic' });
    });

    it('keeps an explicit server error as it is', () => {
        const { state, deps } = harness([{ ...streaming('Blocked by the privacy shield'), isError: true }]);
        finishAbnormally(newTurn({ producedWork: true }), deps);
        expect(state.messages[0]).toMatchObject({ isStreaming: false, isError: true, content: 'Blocked by the privacy shield' });
    });
});

describe('recoverPersistedReply', () => {
    it('swaps the persisted reply in once it is saved', async () => {
        vi.useFakeTimers();
        const saved: ChatMessage[] = [{ id: 'u1', role: 'user', content: 'q' }, { id: 'srv', role: 'assistant', content: 'Full answer' }];
        const reload = vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce(saved);
        const { state, deps } = harness([{ id: 'a1', role: 'assistant', content: 'x', isInterrupted: true }]);
        const done = recoverPersistedReply('a1', reload, deps);
        await vi.advanceTimersByTimeAsync(RECOVERY_DELAYS_MS[0] + RECOVERY_DELAYS_MS[1]);
        await done;
        expect(reload).toHaveBeenCalledTimes(2);
        expect(state.messages).toBe(saved);
    });

    it('stops when the user moved on', async () => {
        vi.useFakeTimers();
        const reload = vi.fn();
        const { deps } = harness([{ id: 'other', role: 'user', content: 'next' }]);
        const done = recoverPersistedReply('a1', reload, deps);
        await vi.advanceTimersByTimeAsync(RECOVERY_DELAYS_MS[0]);
        await done;
        expect(reload).not.toHaveBeenCalled();
    });
});

describe('finishStreamEnd and finishWithError', () => {
    const memory = { getMemoryLock: () => null, isTestChat: false, memoryWriteEnabled: () => true };

    it('closes a completed turn with a memory watch', () => {
        const { state, deps } = harness([streaming('ok')]);
        const turn = newTurn({ sawDone: true, conversationId: 'c1' });
        finishStreamEnd(turn, deps, memory);
        expect(turn.flusher.flushNow).toHaveBeenCalled();
        expect(state.messages[0]).toMatchObject({ isStreaming: false, memoryWatch: { conversationId: 'c1', since: turn.startedAt } });
    });

    it('treats a stream without done as interrupted', () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const { state, deps } = harness([streaming()]);
        finishStreamEnd(newTurn(), deps, memory);
        expect(state.messages[0]).toMatchObject({ isError: true });
    });

    it('ignores an abort, and closes quietly after done', () => {
        const { state, deps } = harness([streaming('answer')]);
        finishWithError(Object.assign(new Error('aborted'), { name: 'AbortError' }), newTurn(), deps);
        expect(state.messages[0].isStreaming).toBe(true);
        finishWithError(new Error('socket reset'), newTurn({ sawDone: true }), deps);
        expect(state.messages[0]).toMatchObject({ isStreaming: false, content: 'answer' });
        expect(state.messages[0].isError).toBeUndefined();
    });
});

describe('turnMemoryWatch', () => {
    const turn = newTurn({ conversationId: 'c1' });
    it('watches only when memory could have been written', () => {
        const ok = { getMemoryLock: () => null, isTestChat: false, memoryWriteEnabled: () => true };
        expect(turnMemoryWatch(turn, ok)).toEqual({ conversationId: 'c1', since: turn.startedAt });
        expect(turnMemoryWatch(turn, { ...ok, getMemoryLock: null })).toBeNull();
        expect(turnMemoryWatch(turn, { ...ok, getMemoryLock: () => 'user_paused' })).toBeNull();
        expect(turnMemoryWatch(turn, { ...ok, isTestChat: true })).toBeNull();
        expect(turnMemoryWatch(turn, { ...ok, customEndpoint: '/x' })).toBeNull();
        expect(turnMemoryWatch(turn, { ...ok, memoryWriteEnabled: () => false })).toBeNull();
        expect(turnMemoryWatch(newTurn(), ok)).toBeNull();
    });
});

describe('a turn refused with an HTTP status', () => {
    const run = (err: HttpTurnError) => {
        const { state, deps } = harness([streaming()]);
        finishWithError(err, newTurn(), deps);
        return state;
    };

    it('413 says the request is too large and stays an error', () => {
        const state = run(new HttpTurnError(413, 'Request body too large'));
        expect(state.messages[0]).toMatchObject({ isStreaming: false, isError: true, content: 'chat.error.request_too_large' });
        expect(state.loading).toBe(false);
    });

    it('502, 503 and 504 say the server did not answer in time', () => {
        for (const status of [502, 503, 504]) {
            expect(run(new HttpTurnError(status, null)).messages[0]).toMatchObject({ isError: true, content: 'chat.error.gateway_timeout' });
        }
    });

    it('another status shows the JSON error text of the server', () => {
        expect(run(new HttpTurnError(400, 'Attachment type not allowed')).messages[0]).toMatchObject({ isError: true, content: 'Attachment type not allowed' });
    });

    it('without a body it names the status', () => {
        expect(run(new HttpTurnError(500, null)).messages[0]).toMatchObject({ isError: true, content: 'chat.error.http_status' });
    });

    it('httpTurnErrorFrom reads {error} from a JSON body and survives a non-JSON one', async () => {
        const withBody = await httpTurnErrorFrom({ status: 400, json: async () => ({ error: ' Nope ', code: 'x' }) });
        expect(withBody).toMatchObject({ status: 400, serverMessage: 'Nope' });
        const html = await httpTurnErrorFrom({ status: 413, json: async () => { throw new SyntaxError('not json'); } });
        expect(html).toMatchObject({ status: 413, serverMessage: null });
    });
});
