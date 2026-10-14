import { describe, expect, it, vi } from 'vitest';
import { applyTurnEvent, readTurnStream, type ChatTurn, type TurnStreamHandlers } from './turnStream';

const newTurn = (): ChatTurn => ({
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
});

const handlers = (extra: Partial<TurnStreamHandlers> = {}): TurnStreamHandlers => ({ dispatch: vi.fn(), isDirectMode: false, ...extra });

describe('applyTurnEvent', () => {
    it('marks work, done and the conversation, then dispatches with the turn ids', () => {
        const turn = newTurn();
        const h = handlers();
        applyTurnEvent(turn, 'content', { text: 'x' }, h);
        expect(turn.producedWork).toBe(true);
        applyTurnEvent(turn, 'done', { conversationId: 'c9' }, h);
        expect(turn.sawDone).toBe(true);
        expect(turn.conversationId).toBe('c9');
        expect(h.dispatch).toHaveBeenLastCalledWith('done', { conversationId: 'c9' }, expect.objectContaining({ assistantMsgId: 'a1', userMsgId: 'u1', flusher: turn.flusher }));
    });

    it('does not count a non-work event as work', () => {
        const turn = newTurn();
        applyTurnEvent(turn, 'thinking', {}, handlers());
        expect(turn.producedWork).toBe(false);
    });

    it('remembers what was produced, keeping an earlier title for a titleless follow-up', () => {
        const turn = newTurn();
        applyTurnEvent(turn, 'workspace_update', { content: '# Plan\nbody' }, handlers());
        expect(turn.workRef.current).toEqual({ kind: 'notebook', title: 'Plan' });
        applyTurnEvent(turn, 'workspace_update', {}, handlers());
        expect(turn.workRef.current).toEqual({ kind: 'notebook', title: 'Plan' });
        applyTurnEvent(turn, 'webpage_doc_update', {}, handlers());
        expect(turn.workRef.current).toEqual({ kind: 'webpage', title: null });
    });

    it('reports a created and a titled conversation in direct mode only', () => {
        const onDirectConversation = vi.fn();
        applyTurnEvent(newTurn(), 'conversation_created', { conversationId: 'c1' }, handlers({ onDirectConversation }));
        expect(onDirectConversation).not.toHaveBeenCalled();
        const direct = handlers({ isDirectMode: true, onDirectConversation });
        applyTurnEvent(newTurn(), 'conversation_created', { conversationId: 'c1' }, direct);
        applyTurnEvent(newTurn(), 'title', { conversationId: 'c1', title: 'T' }, direct);
        expect(onDirectConversation.mock.calls).toEqual([[{ conversationId: 'c1' }], [{ conversationId: 'c1', title: 'T' }]]);
    });
});

describe('readTurnStream', () => {
    const response = (text: string) => new Response(new ReadableStream<Uint8Array>({
        start(c) { c.enqueue(new TextEncoder().encode(text)); c.close(); },
    }));

    it('applies every event and survives a bad line and a throwing handler', async () => {
        const turn = newTurn();
        const dispatch = vi.fn((event: string) => { if (event === 'content') throw new Error('boom'); });
        await readTurnStream(response('event: content\ndata: {"text":"a"}\n\ndata: {bad\n\nevent:done\r\ndata:{"conversationId":"c2"}'), new AbortController().signal, turn, handlers({ dispatch }));
        expect(dispatch.mock.calls.map(c => c[0])).toEqual(['content', 'done']);
        expect(turn.producedWork).toBe(true);
        expect(turn.sawDone).toBe(true);
        expect(turn.conversationId).toBe('c2');
    });
});
