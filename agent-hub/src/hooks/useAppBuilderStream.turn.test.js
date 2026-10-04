import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/components/admin/Studio/AppStudio/studioAppsApi', () => {
    return { studioAppsApi: { getBuilderSession: vi.fn() } };
});
vi.mock('@/utils/helpers', async (importOriginal) => {
    const actual = await importOriginal();
    return { ...actual, authFetch: vi.fn() };
});

import { studioAppsApi } from '@/components/admin/Studio/AppStudio/studioAppsApi';
import { authFetch } from '@/utils/helpers';
import useAppBuilderStream, { openTurn, rateOf } from './useAppBuilderStream';

const enc = new TextEncoder();
const sse = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
function sseResponse(events) {
    const stream = new ReadableStream({
        start(controller) { controller.enqueue(enc.encode(events.join(''))); controller.close(); },
    });
    return { ok: true, status: 200, body: stream };
}

beforeEach(() => {
    vi.clearAllMocks();
    const notFound = new Error('no session');
    notFound.status = 404;
    studioAppsApi.getBuilderSession.mockRejectedValue(notFound);
});

// The film's state — what the waiting card, the engine line, the ghost cell
// and the checklist read. Same turn contract as the automation builder's hook.
describe('useAppBuilderStream — turn record, engine, tool calls, checklist', () => {
    it('opens a turn on send and fills it from builder_session / ping / round_start / prompt_progress; the first output ends the silence', async () => {
        authFetch.mockResolvedValue(sseResponse([
            sse('builder_session', { sessionId: 'bs-1', appId: 'app-1' }),
            sse('model_selected', { modelId: 'gemma-4-26b-a4b', tier: 'fast' }),
            sse('ping', {}),
            sse('ping', {}),
            sse('round_start', { iter: 0, modelId: 'gemma-4-26b-a4b', promptChars: 90000, effort: 'none', local: true, providerType: 'llamacpp' }),
            sse('prompt_progress', { iter: 0, total: 24000, cache: 20000, processed: 12000, timeMs: 800 }),
            sse('thinking_start', { partId: 'p0' }),
            sse('thinking', { delta: 'hm', partId: 'p0' }),
            sse('thinking_stop', { partId: 'p0' }),
            sse('usage', { iter: 0, effort: 'none', prompt_tokens: 24000, completion_tokens: 300, timings: { prompt_n: 4000, prompt_ms: 8000, predicted_n: 300, predicted_ms: 15000 }, totals: { prompt: 24000, completion: 300 }, inputTokens: 24000, outputTokens: 300 }),
            sse('done', { appId: 'app-1', finalized: false }),
        ]));
        const { result } = renderHook(() => useAppBuilderStream({ appId: 'app-1' }));
        expect(result.current.turn).toBeNull();
        await act(async () => { await result.current.send('Build', { modelTier: 'fast' }); });
        const { turn, engine } = result.current;
        expect(turn.sentAt).toBeTypeOf('number');
        expect(turn.tier).toBe('fast');
        expect(turn.sessionAt).toBeTypeOf('number');
        expect(turn.pings).toBe(2);
        expect(turn.modelId).toBe('gemma-4-26b-a4b');
        expect(turn.promptChars).toBe(90000);
        expect(turn.local).toBe(true);
        expect(turn.providerType).toBe('llamacpp');
        expect(turn.progress).toMatchObject({ total: 24000, cache: 20000, processed: 12000, timeMs: 800 });
        expect(turn.firstEventAt).toBeTypeOf('number');
        expect(turn.phase).toBe('writing');
        // The engine line: where it runs and how fast it read/wrote this round.
        expect(engine.modelId).toBe('gemma-4-26b-a4b');
        expect(engine.local).toBe(true);
        expect(engine.readTokPerSec).toBe(500);
        expect(engine.writeTokPerSec).toBe(20);
        expect(engine.lastUsage.promptTokens).toBe(24000);
        // Explicit tier → no "Auto → Fast" badge on the bubble.
        const assistant = result.current.messages.find((m) => m.role === 'assistant');
        expect(assistant.autoSelectedTier).toBeUndefined();
        expect(assistant.usage).toEqual({ inputTokens: 24000, outputTokens: 300 });
    });

    it('an auto turn keeps the resolved-tier badge', async () => {
        authFetch.mockResolvedValue(sseResponse([
            sse('model_selected', { modelId: 'x', tier: 'thinking' }),
            sse('message', { content: 'ok' }),
            sse('done', { appId: 'app-1' }),
        ]));
        const { result } = renderHook(() => useAppBuilderStream({ appId: 'app-1' }));
        await act(async () => { await result.current.send('Build'); });
        expect(result.current.messages.find((m) => m.role === 'assistant').autoSelectedTier).toBe('thinking');
    });

    it('tool calls ride the assistant message, typed; tool_draft is the card being typed and clears when the call lands', async () => {
        authFetch.mockResolvedValue(sseResponse([
            sse('tool_draft', { iter: 0, name: 'app_add_components', chars: 80, count: 2, items: [{ kind: 'component', type: 'stat', label: 'Tot', partial: false }, { kind: 'component', type: null, label: null, partial: true }], parentId: 'sec_1' }),
            sse('tool_call', { name: 'app_add_components', ok: true, summary: 'Added 2', added: [{ id: 'c1', type: 'stat', label: 'Totaal' }, { id: 'c2', type: 'data_grid', label: null }], arguments: '{"parentId":"sec_1"}', result: '{"added":[]}' }),
            sse('tool_call', { name: 'app_set_action', ok: false, summary: 'Unknown screen', error: 'Unknown screenId "scr_x".', hint: 'Use a real id.' }),
            sse('done', { appId: 'app-1' }),
        ]));
        const seen = [];
        const { result } = renderHook(() => useAppBuilderStream({ appId: 'app-1' }));
        // Observe the draft mid-stream through a rerender-time probe.
        const unsub = setInterval(() => { if (result.current.toolDraft) seen.push(result.current.toolDraft); }, 0);
        await act(async () => { await result.current.send('Build'); });
        clearInterval(unsub);
        const assistant = result.current.messages.find((m) => m.role === 'assistant');
        expect(assistant.toolCalls).toHaveLength(2);
        expect(assistant.toolCalls[0]).toMatchObject({ name: 'app_add_components', ok: true, added: [{ id: 'c1', type: 'stat', label: 'Totaal' }, { id: 'c2', type: 'data_grid', label: null }], arguments: '{"parentId":"sec_1"}' });
        expect(assistant.toolCalls[1]).toMatchObject({ name: 'app_set_action', ok: false, error: 'Unknown screenId "scr_x".', hint: 'Use a real id.' });
        expect(result.current.messages.some((m) => m.kind === 'tool')).toBe(false, 'no separate tool items any more');
        expect(result.current.toolDraft).toBeNull();
    });

    it('plan {todos} fills the checklist and never touches the pending artifact; a snapshot rehydrates it', async () => {
        studioAppsApi.getBuilderSession.mockResolvedValue({ snapshot: { sessionId: 'bs-9', messages: [], todos: [{ text: 'Old item', done: true }] } });
        authFetch.mockResolvedValue(sseResponse([
            sse('plan', { todos: [{ text: 'Koppel de tabel', done: false }, { text: 'Tegels', done: false }] }),
            sse('plan', { todos: [{ text: 'Koppel de tabel', done: true }, { text: 'Tegels', done: false }] }),
            sse('done', { appId: 'app-1' }),
        ]));
        const { result } = renderHook(() => useAppBuilderStream({ appId: 'app-1' }));
        await act(async () => { await Promise.resolve(); });
        expect(result.current.todos).toEqual([{ text: 'Old item', done: true }]);
        await act(async () => { await result.current.send('Build'); });
        expect(result.current.todos).toEqual([{ text: 'Koppel de tabel', done: true }, { text: 'Tegels', done: false }]);
        expect(result.current.pendingPlan).toBeNull();
    });

    it('openTurn and rateOf follow the automation builder contract', () => {
        const t = openTurn('fast');
        expect(Object.keys(t).sort()).toEqual(['firstEventAt', 'iter', 'lastPingAt', 'local', 'modelId', 'phase', 'pings', 'progress', 'promptChars', 'providerType', 'roundStartedAt', 'sentAt', 'sessionAt', 'tier', 'usage']);
        expect(rateOf(4000, 8000)).toBe(500);
        expect(rateOf(0, 100)).toBeNull();
        expect(rateOf(undefined, 100)).toBeNull();
    });
});
