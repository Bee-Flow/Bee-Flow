import { renderHook, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import useAutomationBuilderStream from './useAutomationBuilderStream';
import { authFetch } from '../utils/helpers';

vi.mock('../utils/helpers', () => ({ API_BASE: '', authFetch: vi.fn() }));

/**
 * The build visualisations' feed: three server events the hook used to drop
 * (`tool_draft`, `prompt_progress`, `usage`) and the extended `round_start`.
 *
 *   • `state.toolDraft` is the tool call the model is TYPING — it appears on
 *     `tool_draft`, counts as the turn's first event (the waiting card hands
 *     over to the ghost slot), and is gone the moment the matching
 *     `tool_call` lands, on a new round, and on error/abort/finish.
 *   • `turn.phase` is 'reading' from `round_start` until the first output,
 *     then 'writing'; `turn.progress` mirrors llama-server's prompt progress.
 *   • `state.engine` survives across turns: which model, whether it is local,
 *     and the read/write rates from the last round's timings.
 *   • `state.dryRunSeq` bumps per `dryrun` so the canvas can replay it.
 */

const enc = new TextEncoder();
const sse = (event, data) => enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

function openBody() {
    let controller;
    const stream = new ReadableStream({ start(c) { controller = c; } });
    return { stream, push: (chunk) => controller.enqueue(chunk), close: () => controller.close() };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

async function startTurn(sendArgs = { message: 'x', modelTier: 'fast' }) {
    const body = openBody();
    authFetch.mockResolvedValue({ ok: true, status: 200, body: body.stream });
    const { result } = renderHook(() => useAutomationBuilderStream({ automationId: 'a1' }));
    let sending;
    await act(async () => {
        sending = result.current.send(sendArgs);
        await flush();
    });
    const push = async (...events) => {
        await act(async () => {
            for (const [ev, data] of events) body.push(sse(ev, data));
            await flush();
        });
    };
    const finish = async () => {
        await act(async () => {
            body.push(sse('done', {}));
            body.close();
            await sending;
        });
    };
    return { result, push, finish };
}

describe('useAutomationBuilderStream — build visualisation feed', () => {
    let clock;
    beforeEach(() => {
        authFetch.mockReset();
        clock = 5_000_000;
        vi.spyOn(Date, 'now').mockImplementation(() => { clock += 1000; return clock; });
    });
    afterEach(() => { vi.restoreAllMocks(); });

    it('round_start opens a reading phase, records local/providerType and seeds the engine', async () => {
        const { result, push, finish } = await startTurn();
        expect(result.current.state.engine).toBeNull();
        expect(result.current.state.turn.phase).toBeNull();

        await push(['round_start', { iter: 0, modelId: 'qwen3.6-35b-a3b', promptChars: 90_000, effort: 'none', local: true, providerType: 'openai-compatible' }]);
        const t = result.current.state.turn;
        expect(t.phase).toBe('reading');
        expect(t.iter).toBe(0);
        expect(t.local).toBe(true);
        expect(t.providerType).toBe('openai-compatible');
        expect(t.progress).toBeNull();
        expect(result.current.state.engine).toMatchObject({ modelId: 'qwen3.6-35b-a3b', local: true, providerType: 'openai-compatible' });
        await finish();
    });

    it('round_start without the new fields keeps working (old server)', async () => {
        const { result, push, finish } = await startTurn();
        await push(['round_start', { iter: 0, modelId: 'm', promptChars: 10 }]);
        expect(result.current.state.turn.local).toBeNull();
        expect(result.current.state.turn.phase).toBe('reading');
        expect(result.current.state.engine.local).toBeNull();
        await finish();
    });

    it('prompt_progress lands on the turn with numbers coerced', async () => {
        const { result, push, finish } = await startTurn();
        await push(
            ['round_start', { iter: 0, modelId: 'm', promptChars: 10, local: true }],
            ['prompt_progress', { iter: 0, total: '28000', cache: 26900, processed: 27400, timeMs: 3200 }],
        );
        const t = result.current.state.turn;
        expect(t.phase).toBe('reading');
        expect(t.progress).toMatchObject({ total: 28000, cache: 26900, processed: 27400, timeMs: 3200 });
        expect(t.progress.at).toEqual(expect.any(Number));
        // The waiting card is still up: progress is not output.
        expect(t.firstEventAt).toBeNull();
        await finish();
    });

    it('tool_draft sets state.toolDraft, flips the phase to writing and counts as the first event', async () => {
        const { result, push, finish } = await startTurn();
        await push(['round_start', { iter: 0, modelId: 'm', promptChars: 10, local: true }]);
        expect(result.current.state.toolDraft).toBeNull();

        await push(['tool_draft', {
            iter: 0, name: 'builder_add_steps', chars: 140, count: 2,
            steps: [{ type: 'action', tool: 'nextcloud_list_files', label: 'List invoices', partial: false }, { type: 'action', tool: 'nextcloud_read_file', label: 'Read ea', partial: true }],
            inspect: [],
        }]);
        const d = result.current.state.toolDraft;
        expect(d.name).toBe('builder_add_steps');
        expect(d.steps).toHaveLength(2);
        expect(d.steps[1]).toMatchObject({ tool: 'nextcloud_read_file', partial: true });
        expect(d.count).toBe(2);
        expect(d.chars).toBe(140);
        expect(d.iter).toBe(0);
        expect(d.at).toEqual(expect.any(Number));
        const t = result.current.state.turn;
        expect(t.phase).toBe('writing');
        expect(t.firstEventAt).toEqual(expect.any(Number));
        await finish();
    });

    it('a malformed tool_draft is normalised, never thrown on', async () => {
        const { result, push, finish } = await startTurn();
        await push(['tool_draft', { name: 'builder_inspect_tool', steps: 'nope', inspect: 'nope', count: 'x', chars: null }]);
        expect(result.current.state.toolDraft).toMatchObject({ name: 'builder_inspect_tool', steps: [], inspect: [], count: 0, chars: 0 });
        await finish();
    });

    it('the matching tool_call clears the draft; a new round clears it too', async () => {
        const { result, push, finish } = await startTurn();
        await push(
            ['round_start', { iter: 0, modelId: 'm', promptChars: 10 }],
            ['tool_draft', { iter: 0, name: 'builder_add_action', chars: 20, count: 1, steps: [{ type: 'action', tool: 'x', label: null, partial: true }], inspect: [] }],
        );
        expect(result.current.state.toolDraft).not.toBeNull();
        await push(['tool_call', { name: 'builder_add_action', arguments: {}, result: { ok: true } }]);
        expect(result.current.state.toolDraft).toBeNull();

        await push(['tool_draft', { iter: 0, name: 'builder_request_dry_run', chars: 2, count: 0, steps: [], inspect: [] }]);
        expect(result.current.state.toolDraft?.name).toBe('builder_request_dry_run');
        await push(['round_start', { iter: 1, modelId: 'm', promptChars: 12 }]);
        expect(result.current.state.toolDraft).toBeNull();
        expect(result.current.state.turn.phase).toBe('reading');
        expect(result.current.state.turn.iter).toBe(1);
        await finish();
    });

    it('error and builder_aborted clear the draft', async () => {
        const { result, push, finish } = await startTurn();
        await push(['tool_draft', { name: 'builder_add_action', steps: [], inspect: [], count: 0, chars: 1 }]);
        await push(['error', { error: 'boom' }]);
        expect(result.current.state.toolDraft).toBeNull();
        await push(['tool_draft', { name: 'builder_add_action', steps: [], inspect: [], count: 0, chars: 1 }]);
        await push(['builder_aborted', { reason: 'max_iterations', iterations: 24 }]);
        expect(result.current.state.toolDraft).toBeNull();
        await finish();
    });

    it('finishing the stream clears a dangling draft', async () => {
        const { result, push, finish } = await startTurn();
        await push(['tool_draft', { name: 'builder_add_action', steps: [], inspect: [], count: 0, chars: 1 }]);
        await finish();
        expect(result.current.state.running).toBe(false);
        expect(result.current.state.toolDraft).toBeNull();
    });

    it('usage derives read/write rates from llama timings and keeps them across turns', async () => {
        const { result, push, finish } = await startTurn();
        await push(
            ['round_start', { iter: 0, modelId: 'm', promptChars: 10, local: true }],
            ['usage', {
                iter: 0, effort: 'none', prompt_tokens: 28_000, completion_tokens: 410, cached_tokens: 26_900,
                timings: { prompt_n: 1100, cache_n: 26_900, prompt_ms: 7_500, predicted_n: 410, predicted_ms: 18_600 },
                totals: {},
            }],
        );
        const e = result.current.state.engine;
        expect(e.lastUsage).toMatchObject({ promptTokens: 28_000, completionTokens: 410, cachedTokens: 26_900 });
        // 1100 tokens / 7.5 s ≈ 147 tok/s read; 410 / 18.6 s ≈ 22 tok/s write.
        expect(e.readTokPerSec).toBe(147);
        expect(e.writeTokPerSec).toBe(22);
        expect(result.current.state.turn.usage).toBe(e.lastUsage);
        await finish();

        // Next turn: the engine facts survive the reset of `turn`.
        const engineBefore = result.current.state.engine;
        await act(async () => {
            const body = openBody();
            authFetch.mockResolvedValue({ ok: true, status: 200, body: body.stream });
            const sending = result.current.send({ message: 'y', modelTier: 'fast' });
            await flush();
            body.push(sse('done', {}));
            body.close();
            await sending;
        });
        expect(result.current.state.engine).toBe(engineBefore);
        expect(result.current.state.turn.usage).toBeNull();
    });

    it('usage without timings (cloud runtime) keeps the previous rates', async () => {
        const { result, push, finish } = await startTurn();
        await push(
            ['usage', { prompt_tokens: 10, completion_tokens: 5, timings: { prompt_n: 100, prompt_ms: 1000, predicted_n: 50, predicted_ms: 1000 } }],
            ['usage', { prompt_tokens: 12, completion_tokens: 6 }],
        );
        const e = result.current.state.engine;
        expect(e.readTokPerSec).toBe(100);
        expect(e.writeTokPerSec).toBe(50);
        expect(e.lastUsage.timings).toBeNull();
        expect(e.lastUsage.cachedTokens).toBeNull();
        await finish();
    });

    it('message / thinking_start after a round_start flip the phase to writing', async () => {
        const { result, push, finish } = await startTurn();
        await push(['round_start', { iter: 0, modelId: 'm', promptChars: 10 }]);
        expect(result.current.state.turn.phase).toBe('reading');
        await push(['message', { content: 'Hi' }]);
        expect(result.current.state.turn.phase).toBe('writing');
        await push(['round_start', { iter: 1, modelId: 'm', promptChars: 10 }]);
        expect(result.current.state.turn.phase).toBe('reading');
        await push(['thinking_start', { partId: 'p1' }]);
        expect(result.current.state.turn.phase).toBe('writing');
        await finish();
    });

    it('dryrun bumps dryRunSeq and still lands the rows at once', async () => {
        const { result, push, finish } = await startTurn();
        expect(result.current.state.dryRunSeq).toBe(0);
        const steps = [{ stepId: 't', status: 'success' }, { stepId: 'a', status: 'success' }];
        await push(['dryrun', { run: { id: 'r1', status: 'success' }, steps }]);
        expect(result.current.state.dryRunSeq).toBe(1);
        expect(result.current.state.steps).toEqual(steps);
        await push(['dryrun', { run: { id: 'r2', status: 'failed' }, steps: [] }]);
        expect(result.current.state.dryRunSeq).toBe(2);
        await finish();
        await act(async () => { result.current.reset(); });
        expect(result.current.state.dryRunSeq).toBe(0);
        expect(result.current.state.toolDraft).toBeNull();
    });
});
