import { renderHook, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import useAutomationBuilderStream from './useAutomationBuilderStream';
import { authFetch } from '../utils/helpers';

vi.mock('../utils/helpers', () => ({ API_BASE: '', authFetch: vi.fn() }));

/**
 * Characterisation (golden) test for the builder stream hook, written before
 * the hook was split into hooks/automationBuilder/. It pins the paths the
 * focused tests next to it leave out: the remaining SSE events, the draft
 * conflict rule, the non-ok answers of the stream request, and the run
 * controls (watchActiveRun, hydrateLastRun, stopRun, retryFromStep, a failed
 * execute). The returned key list is pinned too, so the hook's surface cannot
 * drift during a move.
 */

const enc = new TextEncoder();
const sse = (event: string, data: unknown) => enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
const flush = () => new Promise((r) => setTimeout(r, 0));
const mockedFetch = vi.mocked(authFetch);

type Hook = ReturnType<typeof useAutomationBuilderStream>;

function jsonResponse(body: unknown, { ok = true, status = 200 } = {}) {
    return { ok, status, json: async () => body } as unknown as Response;
}

async function streamTurn(frames: Array<[string, unknown]>, setup?: (h: Hook) => void) {
    let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
    const stream = new ReadableStream<Uint8Array>({ start(c) { controller = c; } });
    mockedFetch.mockResolvedValue({ ok: true, status: 200, body: stream } as unknown as Response);
    const { result } = renderHook(() => useAutomationBuilderStream({ automationId: 'a1', title: 'T0' }));
    if (setup) act(() => setup(result.current));
    let sending: Promise<void> | undefined;
    await act(async () => {
        sending = result.current.send({ message: 'hi', modelTier: 'fast' });
        await flush();
    });
    await act(async () => {
        for (const [ev, data] of frames) controller!.enqueue(sse(ev, data));
        await flush();
    });
    const finish = async () => {
        await act(async () => { controller!.close(); await sending; });
    };
    return { result, finish };
}

describe('useAutomationBuilderStream characterisation: stream events', () => {
    beforeEach(() => { mockedFetch.mockReset(); });

    it('returns exactly the same keys', () => {
        const { result } = renderHook(() => useAutomationBuilderStream());
        expect(Object.keys(result.current)).toEqual([
            'state', 'send', 'stop', 'reset', 'hydrate', 'hydrateLastRun', 'setDraft', 'markServerConfirmed',
            'acceptExternalDraft', 'dismissExternalDraft', 'dismissProposal', 'dismissPlan', 'executeStep',
            'retryFromStep', 'stopRun', 'pollRunProgress', 'clearDryRun', 'clearError', 'setValidation',
            'settleRun', 'setRunResult', 'watchActiveRun',
        ]);
        expect(result.current.state).toMatchObject({
            builderSessionId: null, automationId: null, draft: null, messages: [], running: false,
            dryRunSeq: 0, metadataSeq: 0, title: null, webSearch: null, turn: null, engine: null,
        });
    });

    it('posts the turn body and keeps the optional fields out', async () => {
        const { finish } = await streamTurn([]);
        const [url, init] = mockedFetch.mock.calls[0] as [string, RequestInit];
        expect(url).toBe('/api/automation/builder/stream');
        const body = JSON.parse(String(init.body));
        expect(body).toMatchObject({ message: 'hi', modelTier: 'fast', automationId: 'a1', builderSessionId: null, attachments: [], webSearchEnabled: true, disabledMedia: {}, canvasScope: null, history: [] });
        expect(body).not.toHaveProperty('workMode');
        expect(body).not.toHaveProperty('seedMetadata');

        await finish();
    });

    it('folds the remaining events into state', async () => {
        const { result, finish } = await streamTurn([
            ['builder_session', { builderSessionId: 'bs1', automationId: 'a2' }],
            ['prompt_progress', { total: 100, cache: 40, processed: 60, timeMs: 12 }],
            ['tool_draft', { name: 'builder_add_steps', steps: [{ id: 's1' }], capped: true, chars: 50, iter: 2 }],
            ['usage', { prompt_tokens: 10, completion_tokens: 5, cached_tokens: 3, timings: { prompt_n: 100, prompt_ms: 1000, predicted_n: 20, predicted_ms: 1000 } }],
            ['summary', { summary: 'Sends mail', hasSideEffects: true }],
            ['plan', { todos: [{ id: 't1', text: 'do', status: 'pending' }] }],
            ['thinking_start', { partId: 'p1' }],
            ['thinking', { partId: 'p1', text: 'hmm' }],
            ['thinking_stop', { partId: 'p1' }],
            ['finalized', { automationId: 'a2' }],
            ['builder_aborted', { reason: 'max_iterations', iterations: 9 }],
            ['error', { error: 'boom' }],
            ['done', { finalized: true, iterations: 4 }],
            ['not_an_event', { x: 1 }],
        ]);
        const s = result.current.state;
        expect(s.builderSessionId).toBe('bs1');
        expect(s.automationId).toBe('a2');
        expect(s.turn?.progress).toMatchObject({ total: 100, cache: 40, processed: 60, timeMs: 12 });
        expect(s.toolDraft).toBeNull(); // cleared by builder_aborted / error
        expect(s.engine?.lastUsage).toEqual({ promptTokens: 10, completionTokens: 5, cachedTokens: 3, timings: { prompt_n: 100, prompt_ms: 1000, predicted_n: 20, predicted_ms: 1000 } });
        expect(s.engine?.readTokPerSec).toBe(100);
        expect(s.engine?.writeTokPerSec).toBe(20);
        expect(s.summary).toBe('Sends mail');
        expect(s.hasSideEffects).toBe(true);
        expect(s.todos).toEqual([{ id: 't1', text: 'do', status: 'pending' }]);
        expect(s.finalizedId).toBe('a2');
        expect(s.aborted).toEqual({ reason: 'max_iterations', iterations: 9, lastValidation: null });
        expect(s.error).toBe('boom');
        expect(s.lastDone).toEqual({ finalized: true, automationId: 'a2', iterations: 4 });
        const last = s.messages[s.messages.length - 1];
        expect(last.role).toBe('assistant');
        expect(last.thinkingParts?.[0]).toMatchObject({ id: 'p1', text: 'hmm' });
        expect(last.thinkingParts?.[0].endedAt).toEqual(expect.any(Number));
        expect(s.running).toBe(true);
        await finish();
        expect(result.current.state.running).toBe(false);
        expect(result.current.state.messages.some(m => m.isStreaming)).toBe(false);
    });

});

describe('useAutomationBuilderStream characterisation: stream events (2)', () => {
    beforeEach(() => { mockedFetch.mockReset(); });

    it('records tool_draft while it is open', async () => {
        const { result, finish } = await streamTurn([
            ['tool_draft', { name: 'builder_add_steps', steps: [{ id: 's1' }], capped: true, chars: 50, iter: 2 }],
        ]);
        expect(result.current.state.toolDraft).toMatchObject({ name: 'builder_add_steps', steps: [{ id: 's1' }], count: 1, capped: true, inspect: [], chars: 50, iter: 2 });
        expect(result.current.state.turn?.firstEventAt).toEqual(expect.any(Number));
        await finish();
        expect(result.current.state.toolDraft).toBeNull();
    });

    it('takes a draft silently while running', async () => {
        const local = { steps: [{ id: 'mine' }] };
        const incoming = { steps: [{ id: 'theirs' }] };
        const { result, finish } = await streamTurn([
            ['draft', { definition: incoming, automationId: 'a3' }],
        ], h => h.setDraft(local));
        expect(result.current.state.draft).toEqual(incoming);
        expect(result.current.state.lastServerDraft).toEqual(incoming);
        expect(result.current.state.pendingExternalDraft).toBeNull();
        expect(result.current.state.automationId).toBe('a3');
        await finish();
    });

    it('applies a resume snapshot', async () => {
        const { result, finish } = await streamTurn([
            ['resume', { snapshot: { conversation: [{ role: 'user', content: 'old' }], draft: { steps: [] }, summary: 'S', todos: [], reviewQuestions: ['q'], questionsMeta: { planId: 'pl' }, proposal: null } }],
        ]);
        const s = result.current.state;
        expect(s.messages).toEqual([{ role: 'user', content: 'old' }]);
        expect(s.draft).toEqual({ steps: [] });
        expect(s.summary).toBe('S');
        expect(s.reviewQuestions).toEqual(['q']);
        expect(s.reviewQuestionsPlanId).toBe('pl');
        expect(s.proposal).toBeNull();
        await finish();
    });

});

describe('useAutomationBuilderStream characterisation: draft conflict', () => {
    beforeEach(() => { mockedFetch.mockReset(); });

    it('stashes a diverging draft when idle, then accept / dismiss resolve it', async () => {
        // stop() flips `running` off; the fake body ignores the abort signal,
        // so a queued draft still reaches the reader with the hook idle and
        // the local draft diverged from the baseline: a real conflict.
        const base = { steps: [{ id: 'base' }] };
        const incoming = { steps: [{ id: 'theirs' }] };
        let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
        const stream = new ReadableStream<Uint8Array>({ start(c) { controller = c; } });
        mockedFetch.mockResolvedValue({ ok: true, status: 200, body: stream } as unknown as Response);
        const { result } = renderHook(() => useAutomationBuilderStream({ automationId: 'a1', draft: base }));
        act(() => result.current.setDraft({ steps: [{ id: 'local' }] }));
        let sending: Promise<void> | undefined;
        await act(async () => { sending = result.current.send({ message: 'x' }); await flush(); });
        act(() => result.current.stop());
        await act(async () => {
            controller!.enqueue(sse('draft', { definition: incoming, automationId: 'a9' }));
            controller!.close();
            await sending;
        });
        expect(result.current.state.pendingExternalDraft).toEqual(incoming);
        expect(result.current.state.draft).toEqual({ steps: [{ id: 'local' }] });
        expect(result.current.state.lastServerDraft).toEqual(base);
        expect(result.current.state.automationId).toBe('a9');
        act(() => result.current.dismissExternalDraft());
        expect(result.current.state.pendingExternalDraft).toBeNull();
        expect(result.current.state.draft).toEqual({ steps: [{ id: 'local' }] });
        act(() => result.current.markServerConfirmed(incoming));
        expect(result.current.state.lastServerDraft).toEqual(incoming);
    });

    it('acceptExternalDraft promotes the pending draft', async () => {
        const base = { steps: [{ id: 'base' }] };
        const incoming = { steps: [{ id: 'theirs' }] };
        let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
        const stream = new ReadableStream<Uint8Array>({ start(c) { controller = c; } });
        mockedFetch.mockResolvedValue({ ok: true, status: 200, body: stream } as unknown as Response);
        const { result } = renderHook(() => useAutomationBuilderStream({ automationId: 'a1', draft: base }));
        act(() => result.current.setDraft({ steps: [{ id: 'local' }] }));
        let sending: Promise<void> | undefined;
        await act(async () => { sending = result.current.send({ message: 'x' }); await flush(); });
        act(() => result.current.stop());
        await act(async () => {
            controller!.enqueue(sse('draft', { definition: incoming }));
            controller!.close();
            await sending;
        });
        act(() => result.current.acceptExternalDraft());
        expect(result.current.state.draft).toEqual(incoming);
        expect(result.current.state.lastServerDraft).toEqual(incoming);
        expect(result.current.state.pendingExternalDraft).toBeNull();
    });

});

describe('useAutomationBuilderStream characterisation: request failures', () => {
    beforeEach(() => { mockedFetch.mockReset(); });

    it('turns a gateway status into the reopen guidance and other statuses into the server text', async () => {
        mockedFetch.mockResolvedValueOnce({ ok: false, status: 504, body: null, json: async () => ({ error: 'x' }) } as unknown as Response);
        const { result } = renderHook(() => useAutomationBuilderStream({ automationId: 'a1' }));
        await act(async () => { await result.current.send({ message: 'x' }); });
        expect(result.current.state.error).toMatch(/^The connection to the builder dropped/);
        expect(result.current.state.running).toBe(false);
        expect(result.current.state.messages.some(m => m.isStreaming)).toBe(false);

        mockedFetch.mockResolvedValueOnce({ ok: false, status: 400, body: null, json: async () => ({ error: 'Bad input' }) } as unknown as Response);
        await act(async () => { await result.current.send({ message: 'y' }); });
        expect(result.current.state.error).toBe('Bad input');

        mockedFetch.mockRejectedValueOnce(new Error('network down'));
        await act(async () => { await result.current.send({ message: 'z' }); });
        expect(result.current.state.error).toMatch(/^The connection to the builder dropped/);

        mockedFetch.mockRejectedValueOnce(new Error('kaput'));
        await act(async () => { await result.current.send({ message: 'w' }); });
        expect(result.current.state.error).toBe('kaput');

        act(() => result.current.clearError());
        expect(result.current.state.error).toBeNull();
    });

    it('sends the work-mode fields and seedMetadata only when given', async () => {
        mockedFetch.mockResolvedValueOnce({ ok: false, status: 400, body: null, json: async () => ({}) } as unknown as Response);
        const { result } = renderHook(() => useAutomationBuilderStream({ automationId: 'a1' }));
        await act(async () => {
            await result.current.send({ message: 'x', workMode: 'approve', alwaysPlanLarge: true, pauseAfterStep: false, seedMetadata: { title: 'N' }, resume: true, targetAutomationId: 'tx' });
        });
        const [url, init] = mockedFetch.mock.calls[0] as [string, RequestInit];
        expect(url).toBe('/api/automation/builder/stream?resume=1');
        expect(JSON.parse(String(init.body))).toMatchObject({ workMode: 'approve', alwaysPlanLarge: true, pauseAfterStep: false, approvedPlanId: null, selectedStepId: null, seedMetadata: { title: 'N' }, automationId: 'tx' });
        expect(result.current.state.error).toBe('{}');
    });

});

describe('useAutomationBuilderStream characterisation: run controls', () => {
    beforeEach(() => { mockedFetch.mockReset(); });

    it('watchActiveRun surfaces the active run as a running stub and stops', async () => {
        mockedFetch.mockResolvedValue(jsonResponse({ active: [{ automationId: 'other', runId: 'r0', status: 'running' }, { automationId: 'a1', runId: 'r1', status: 'queued', startedAt: 's' }] }));
        const { result } = renderHook(() => useAutomationBuilderStream({ automationId: 'a1' }));
        const found = vi.fn();
        let stop: () => void = () => {};
        await act(async () => { stop = result.current.watchActiveRun(null, found); await flush(); });
        expect(mockedFetch).toHaveBeenCalledWith('/api/automation/_runs/active');
        expect(found).toHaveBeenCalledWith('r1');
        expect(result.current.state.dryRun).toEqual({ id: 'r1', status: 'running', startedAt: 's' });
        stop();
        const noAid = renderHook(() => useAutomationBuilderStream());
        expect(typeof noAid.result.current.watchActiveRun()).toBe('function');
    });

    it('hydrateLastRun restores the newest finished run once, and never over live rows', async () => {
        mockedFetch
            .mockResolvedValueOnce(jsonResponse({ runs: [{ id: 'r9', status: 'success' }] }))
            .mockResolvedValueOnce(jsonResponse({ steps: [{ stepId: 's1', status: 'success' }] }));
        const { result } = renderHook(() => useAutomationBuilderStream({ automationId: 'a 1' }));
        let run: unknown;
        await act(async () => { run = await result.current.hydrateLastRun(); });
        expect(mockedFetch.mock.calls.map(c => c[0])).toEqual(['/api/automation/a%201/runs?limit=1', '/api/automation/runs/r9/steps']);
        expect(run).toEqual({ id: 'r9', status: 'success' });
        expect(result.current.state.dryRun).toEqual({ id: 'r9', status: 'success' });
        expect(result.current.state.steps).toEqual([{ stepId: 's1', status: 'success' }]);

        mockedFetch.mockResolvedValueOnce(jsonResponse({ runs: [{ id: 'r10', status: 'running' }] }));
        await act(async () => { run = await result.current.hydrateLastRun(); });
        expect(run).toBeNull();
        act(() => result.current.clearDryRun());
        expect(result.current.state.dryRun).toBeNull();
        expect(result.current.state.steps).toEqual([]);
    });

    it('stopRun posts the cancel and reports ok', async () => {
        const { result } = renderHook(() => useAutomationBuilderStream({ automationId: 'a1' }));
        expect(await result.current.stopRun(null)).toBe(false);
        mockedFetch.mockResolvedValueOnce(jsonResponse({}, { ok: true }));
        expect(await result.current.stopRun('r/1')).toBe(true);
        expect(mockedFetch).toHaveBeenCalledWith('/api/automation/runs/r%2F1/cancel', { method: 'POST' });
        mockedFetch.mockRejectedValueOnce(new Error('x'));
        expect(await result.current.stopRun('r2')).toBe(false);
    });

});

describe('useAutomationBuilderStream characterisation: run controls (2)', () => {
    beforeEach(() => { mockedFetch.mockReset(); });

    it('a failed execute replaces the step row (and its sub-rows) with an error row; retry runs mode from', async () => {
        const { result } = renderHook(() => useAutomationBuilderStream({ automationId: 'a1' }));
        act(() => result.current.setRunResult({ id: 'r1', status: 'running' }, [
            { stepId: 's1', status: 'success', output: 1 },
            { stepId: 's1/inner', status: 'success' },
            { stepId: 's2', status: 'success' },
        ]));
        mockedFetch.mockImplementation(async (url: string) => {
            if (url.endsWith('/_runs/active')) return jsonResponse({ active: [] });
            return jsonResponse({ error: 'Step blew up' }, { ok: false, status: 400 });
        });
        let out: unknown;
        await act(async () => { out = await result.current.executeStep('s1'); });
        expect(out).toBeNull();
        const s = result.current.state;
        expect(s.error).toBe('Step blew up');
        expect(s.executingStepId).toBeNull();
        expect(s.dryRun).toEqual({ id: 'r1', status: 'error' });
        expect(s.steps).toEqual([
            { stepId: 's1', parentStepId: null, status: 'error', error: 'Step blew up', output: null },
            { stepId: 's2', status: 'success' },
        ]);
        const runCall = mockedFetch.mock.calls.find(c => String(c[0]).includes('/steps/s1/run'))!;
        expect(JSON.parse(String((runCall[1] as RequestInit).body))).toEqual({ mode: 'only' });

        mockedFetch.mockClear();
        await act(async () => { await result.current.retryFromStep('s2', { triggerPayload: { a: 1 } }); });
        const retryCall = mockedFetch.mock.calls.find(c => String(c[0]).includes('/steps/s2/run'))!;
        expect(JSON.parse(String((retryCall[1] as RequestInit).body))).toEqual({ mode: 'from', triggerPayload: { a: 1 } });
    });

    it('dismissProposal / dismissPlan clear their previews; hydrate keeps the draft over a blank snapshot', () => {
        const { result } = renderHook(() => useAutomationBuilderStream({ automationId: 'a1', draft: { steps: [{ id: 'k' }] } }));
        act(() => result.current.hydrate({ draft: {}, proposal: { id: 'p' }, reviewPlan: { id: 'pl' }, sessionId: 'sess' } as never));
        expect(result.current.state.draft).toEqual({ steps: [{ id: 'k' }] });
        expect(result.current.state.builderSessionId).toBe('sess');
        expect(result.current.state.proposal).toEqual({ id: 'p' });
        act(() => result.current.dismissProposal());
        act(() => result.current.dismissPlan());
        expect(result.current.state.proposal).toBeNull();
        expect(result.current.state.reviewPlan).toBeNull();
    });
});
