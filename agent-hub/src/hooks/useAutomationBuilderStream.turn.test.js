import { renderHook, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import useAutomationBuilderStream from './useAutomationBuilderStream';
import { authFetch } from '../utils/helpers';

vi.mock('../utils/helpers', () => ({ API_BASE: '', authFetch: vi.fn() }));

/**
 * `state.turn`: the bookkeeping for the silence before the first token. A
 * local model can sit for minutes reading the prompt, and during that time
 * the stream carries only `builder_session` and the 10 s `ping` heartbeat —
 * which used to fall through `default: break` and vanish. Each event now
 * lands on `turn` copy-on-write (BuildTab's effect keys on the object), and
 * `firstEventAt` is set exactly once, by whichever of thinking_start /
 * message / tool_call comes first.
 *
 * Also here: the transcript is posted WHOLE. A client-side `.slice(-20)`
 * shifted the head of the history by one message per turn, which broke the
 * server-side prompt-prefix cache on every turn past the twentieth message.
 */

const enc = new TextEncoder();
const sse = (event, data) => enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

function openBody() {
    let controller;
    const stream = new ReadableStream({ start(c) { controller = c; } });
    return {
        stream,
        push: (chunk) => controller.enqueue(chunk),
        close: () => controller.close(),
    };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

async function startTurn(sendArgs = { message: 'x', modelTier: 'fast' }, { setup } = {}) {
    const body = openBody();
    authFetch.mockResolvedValue({ ok: true, status: 200, body: body.stream });
    const { result } = renderHook(() => useAutomationBuilderStream({ automationId: 'a1' }));
    if (setup) await act(async () => { setup(result); });
    let sending;
    await act(async () => {
        sending = result.current.send(sendArgs);
        await flush();
    });
    return { result, body, finish: async () => {
        await act(async () => {
            body.push(sse('done', {}));
            body.close();
            await sending;
        });
    } };
}

describe('useAutomationBuilderStream — state.turn', () => {
    it('keeps review previews separate from the draft and clears them on reset', async () => {
        const original = { trigger: { id: 't' }, steps: [{ id: 's', label: 'Original' }] };
        const preview = { trigger: { id: 't' }, steps: [{ id: 's', label: 'Proposed' }] };
        const { result, body, finish } = await startTurn({ message: 'Change it', workMode: 'approve' }, { setup: r => r.current.setDraft(original) });
        await act(async () => {
            body.push(sse('proposal_preview', { id: 'p', definition: preview, baseDefinition: original }));
            body.push(sse('review_plan', { plan: { id: 'plan', status: 'review' } }));
            body.push(sse('review_questions', { questions: [{ id: 'q', prompt: 'Which folder?', options: ['A', 'B'] }] }));
            await flush();
        });
        expect(result.current.state.draft).toEqual(original);
        expect(result.current.state.proposal.definition).toEqual(preview);
        expect(result.current.state.reviewQuestions).toHaveLength(1);
        await finish();
        act(() => result.current.reset());
        expect(result.current.state.proposal).toBeNull();
        expect(result.current.state.reviewPlan).toBeNull();
        expect(result.current.state.reviewQuestions).toBeNull();
    });
    // Date.now advances 1 s per call so "set once" is provable: a second write
    // would land a different number.
    let clock;
    beforeEach(() => {
        authFetch.mockReset();
        clock = 1_000_000;
        vi.spyOn(Date, 'now').mockImplementation(() => { clock += 1000; return clock; });
    });
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('send() seeds a fresh turn with the requested tier and nothing else known yet', async () => {
        const { result, finish } = await startTurn();
        expect(result.current.state.turn).toEqual({
            sentAt: expect.any(Number),
            tier: 'fast',
            sessionAt: null,
            pings: 0,
            lastPingAt: null,
            modelId: null,
            roundStartedAt: null,
            promptChars: null,
            firstEventAt: null,
            // Per-round facts for the build visualisations (viz.test.js).
            iter: null,
            local: null,
            providerType: null,
            phase: null,
            progress: null,
            usage: null,
        });
        await finish();
        // The turn outlives the stream: the measurement is filed from it.
        expect(result.current.state.turn.sentAt).toEqual(expect.any(Number));
    });

    it('lands builder_session, pings, model_selected and round_start copy-on-write', async () => {
        const { result, body, finish } = await startTurn({ message: 'x', modelTier: 'auto' });
        const t0 = result.current.state.turn;
        expect(t0.tier).toBe('auto');

        await act(async () => {
            body.push(sse('builder_session', { builderSessionId: 'bs1', automationId: 'a1' }));
            await flush();
        });
        const t1 = result.current.state.turn;
        expect(t1).not.toBe(t0);
        expect(t1.sessionAt).toEqual(expect.any(Number));
        expect(result.current.state.builderSessionId).toBe('bs1');

        await act(async () => {
            body.push(sse('ping', {}));
            body.push(sse('ping', {}));
            body.push(sse('ping', {}));
            await flush();
        });
        const t2 = result.current.state.turn;
        expect(t2).not.toBe(t1);
        expect(t2.pings).toBe(3);
        expect(t2.lastPingAt).toEqual(expect.any(Number));
        // A heartbeat is not a response.
        expect(t2.firstEventAt).toBeNull();

        await act(async () => {
            body.push(sse('model_selected', { tier: 'thinking', modelId: 'qwen3-27b' }));
            await flush();
        });
        const t3 = result.current.state.turn;
        expect(t3).not.toBe(t2);
        // 'auto' is replaced by what actually ran, so the learned duration is
        // filed under a real bucket.
        expect(t3.tier).toBe('thinking');
        expect(t3.modelId).toBe('qwen3-27b');
        // …and the bubble badge still gets its resolved tier.
        expect(result.current.state.messages[1].autoSelectedTier).toBe('thinking');

        await act(async () => {
            body.push(sse('round_start', { iter: 1, modelId: 'qwen3-27b-q4', promptChars: 112000, effort: 'high' }));
            await flush();
        });
        const t4 = result.current.state.turn;
        expect(t4).not.toBe(t3);
        expect(t4.roundStartedAt).toEqual(expect.any(Number));
        expect(t4.modelId).toBe('qwen3-27b-q4');
        expect(t4.promptChars).toBe(112000);
        // Untouched fields ride along unchanged.
        expect(t4.sessionAt).toBe(t1.sessionAt);
        expect(t4.pings).toBe(3);
        expect(t4.firstEventAt).toBeNull();

        // A second round without a prompt size keeps the last one it heard.
        await act(async () => {
            body.push(sse('round_start', { iter: 2 }));
            await flush();
        });
        expect(result.current.state.turn.promptChars).toBe(112000);
        expect(result.current.state.turn.modelId).toBe('qwen3-27b-q4');

        await finish();
    });

    it('sets firstEventAt once, on the first of thinking_start / message / tool_call', async () => {
        const { result, body, finish } = await startTurn();
        await act(async () => {
            body.push(sse('thinking_start', { partId: 'p1' }));
            await flush();
        });
        const first = result.current.state.turn.firstEventAt;
        expect(first).toEqual(expect.any(Number));
        const turnAfterFirst = result.current.state.turn;

        await act(async () => {
            body.push(sse('thinking', { partId: 'p1', text: 'hm' }));
            body.push(sse('message', { content: 'Hello' }));
            body.push(sse('tool_call', { name: 'builder_set_trigger', arguments: {}, result: {} }));
            await flush();
        });
        expect(result.current.state.turn.firstEventAt).toBe(first);
        // Nothing else on the turn moved, so no copy was made either.
        expect(result.current.state.turn).toBe(turnAfterFirst);
        await finish();
    });

    it.each([
        ['message', { content: 'Hi' }],
        ['tool_call', { name: 'builder_set_trigger', arguments: {}, result: {} }],
        ['thinking', { partId: 'p1', text: 'hm' }],
    ])('%s alone ends the silence too', async (event, data) => {
        const { result, body, finish } = await startTurn();
        expect(result.current.state.turn.firstEventAt).toBeNull();
        await act(async () => {
            body.push(sse(event, data));
            await flush();
        });
        expect(result.current.state.turn.firstEventAt).toEqual(expect.any(Number));
        await finish();
    });

    it('a new send() resets the turn', async () => {
        const { result, body, finish } = await startTurn();
        await act(async () => {
            body.push(sse('ping', {}));
            body.push(sse('thinking_start', { partId: 'p1' }));
            await flush();
        });
        expect(result.current.state.turn.pings).toBe(1);
        expect(result.current.state.turn.firstEventAt).toEqual(expect.any(Number));
        await finish();

        const body2 = openBody();
        authFetch.mockResolvedValue({ ok: true, status: 200, body: body2.stream });
        let sending2;
        await act(async () => {
            sending2 = result.current.send({ message: 'y', modelTier: 'thinking' });
            await flush();
        });
        expect(result.current.state.turn).toMatchObject({ tier: 'thinking', pings: 0, sessionAt: null, firstEventAt: null });
        await act(async () => {
            body2.push(sse('done', {}));
            body2.close();
            await sending2;
        });
    });

    it('posts the whole transcript — no client-side window', async () => {
        const conversation = Array.from({ length: 30 }, (_, i) => ({
            role: i % 2 ? 'assistant' : 'user',
            content: `m${i}`,
            toolCalls: [],
            thinkingParts: [{ id: 'p', text: 'private' }],
        }));
        const { result, finish } = await startTurn(
            { message: 'x', modelTier: 'fast' },
            { setup: (r) => r.current.hydrate({ conversation }) },
        );
        expect(authFetch).toHaveBeenCalledTimes(1);
        const posted = JSON.parse(authFetch.mock.calls[0][1].body);
        expect(posted.history).toHaveLength(30);
        expect(posted.history[0]).toEqual({ role: 'user', content: 'm0' });
        expect(posted.history[29]).toEqual({ role: 'assistant', content: 'm29' });
        // Only role + content travel; reasoning and tool calls stay local.
        expect(Object.keys(posted.history[5])).toEqual(['role', 'content']);
        expect(result.current.state.messages).toHaveLength(32);
        await finish();
    });
});
