import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import useAutomationBuilderStream from '../useAutomationBuilderStream';
import { installRunTransport, json } from '@/test/runTransport';
import { FOLLOW_PAUSED_MS, FOLLOW_RUNNING_MS, LOST_RUN_MESSAGE } from './useFollowedRun';

/**
 * The run tracker (useFollowedRun), through the stream hook that owns it: a run
 * is followed by the id the server gave it, and the 'running' stub always
 * settles, on a pause or an end, whatever happens to the request or the stream
 * that started it (run-watch F6, F7).
 */

type Status = { status: string; extra?: Record<string, unknown> };
let statuses: Record<string, Status[]>;
let rows: Record<string, unknown[]>;
let server: ReturnType<typeof installRunTransport>;

/** Answers GET /runs/:id with the next queued status (the last one repeats) and /runs/:id/steps with its rows. */
function runServer(extra?: (url: string) => Response | undefined) {
    return installRunTransport((url) => {
        const steps = url.match(/\/runs\/([^/]+)\/steps$/);
        if (steps) return json({ steps: rows[steps[1]] || [] });
        const run = url.match(/\/runs\/([^/?]+)$/);
        if (run && statuses[run[1]]) {
            const queue = statuses[run[1]];
            const next = queue.length > 1 ? queue.shift()! : queue[0];
            return json({ run: { id: run[1], status: next.status, ...(next.extra || {}) } });
        }
        return extra?.(url);
    });
}

const tick = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
const reads = (id: string) => server.urls().filter(u => u.endsWith(`/runs/${id}`)).length;

beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    statuses = {};
    rows = {};
});
afterEach(() => { server?.uninstall(); vi.useRealTimers(); });

describe('useFollowedRun — follow a run by its id', () => {
    it('a 202 runId is followed: a running stub, then the terminal run with its rows, then no more polls', async () => {
        statuses.r1 = [{ status: 'running' }, { status: 'running' }, { status: 'success' }];
        rows.r1 = [{ stepId: 's1', status: 'success', output: { ok: 1 } }];
        server = runServer((url) => (url.includes('/steps/s1/run') ? json({ accepted: true, pending: true, runId: 'r1' }, 202) : undefined));
        const { result } = renderHook(() => useAutomationBuilderStream({ automationId: 'a1' }));

        let out: unknown;
        await act(async () => { void result.current.executeStep('s1').then((r) => { out = r; }); });
        expect(result.current.state.dryRun).toMatchObject({ id: 'r1', status: 'running' });
        expect(result.current.state.executingStepId).toBe('s1');

        await tick(FOLLOW_RUNNING_MS * 3);
        expect(result.current.state.dryRun).toEqual({ id: 'r1', status: 'success' });
        expect(result.current.state.steps).toEqual(rows.r1);
        expect(result.current.state.executingStepId).toBeNull();
        expect(out).toMatchObject({ kind: 'settled', run: { id: 'r1', status: 'success' }, stepRecord: rows.r1[0] });

        const after = reads('r1');
        await tick(FOLLOW_PAUSED_MS * 2);
        expect(reads('r1')).toBe(after);
    });

    it('a pause settles the follow; the paused run is read slowly and picked up again when it goes on', async () => {
        statuses.r2 = [{ status: 'running' }, { status: 'awaiting_form', extra: { awaitingStepId: 'fp' } }];
        rows.r2 = [{ stepId: 'fp', status: 'awaiting_form' }];
        server = runServer();
        const { result } = renderHook(() => useAutomationBuilderStream({ automationId: 'a1' }));

        let settled: unknown;
        await act(async () => { void result.current.followRun('r2').then((s) => { settled = s; }); });
        await tick(FOLLOW_RUNNING_MS * 2);
        expect(settled).toMatchObject({ run: { id: 'r2', status: 'awaiting_form' }, steps: rows.r2 });
        expect(result.current.state.dryRun).toMatchObject({ status: 'awaiting_form', awaitingStepId: 'fp' });

        // Paused: a status read every FOLLOW_PAUSED_MS, the unchanged rows are not read again.
        const stepReads = server.urls().filter(u => u.endsWith('/runs/r2/steps')).length;
        const before = reads('r2');
        await tick(FOLLOW_PAUSED_MS);
        expect(reads('r2')).toBe(before + 1);
        expect(server.urls().filter(u => u.endsWith('/runs/r2/steps')).length).toBe(stepReads);

        // Answered elsewhere: the journey runs again, then ends.
        statuses.r2 = [{ status: 'running' }, { status: 'success' }];
        rows.r2 = [{ stepId: 'fp', status: 'success' }, { stepId: 's9', status: 'success' }];
        const seen: unknown[] = [];
        for (let waited = 0; waited < FOLLOW_PAUSED_MS + FOLLOW_RUNNING_MS * 3; waited += 250) {
            await tick(250);
            const status = result.current.state.dryRun?.status;
            if (seen[seen.length - 1] !== status) seen.push(status);
        }
        expect(seen).toEqual(['awaiting_form', 'running', 'success']);
        expect(result.current.state.dryRun).toMatchObject({ id: 'r2', status: 'success' });
        expect(result.current.state.steps.map(s => s.stepId)).toEqual(['fp', 's9']);
    });

    it('a run that cannot be read (gone) settles the stub as failed instead of polling forever', async () => {
        server = runServer();
        const { result } = renderHook(() => useAutomationBuilderStream({ automationId: 'a1' }));
        let settled: unknown = 'pending';
        await act(async () => { void result.current.followRun('gone').then((s) => { settled = s; }); });
        await tick(FOLLOW_RUNNING_MS);
        expect(result.current.state.dryRun).toMatchObject({ id: 'gone', status: 'error' });
        expect(result.current.state.error).toBe(LOST_RUN_MESSAGE);
        expect(settled).toBeNull();
    });

    it('a newer follow replaces the old one: the old promise answers null and only the new id is read', async () => {
        statuses.a = [{ status: 'running' }];
        statuses.b = [{ status: 'running' }, { status: 'success' }];
        server = runServer();
        const { result } = renderHook(() => useAutomationBuilderStream({ automationId: 'a1' }));
        let first: unknown = 'pending';
        await act(async () => { void result.current.followRun('a').then((s) => { first = s; }); });
        await act(async () => { void result.current.followRun('b'); });
        expect(first).toBeNull();
        const aReads = reads('a');
        await tick(FOLLOW_RUNNING_MS * 3);
        expect(reads('a')).toBe(aReads);
        expect(result.current.state.dryRun).toMatchObject({ id: 'b', status: 'success' });
    });
});

describe('useFollowedRun — the AI builder\'s dry run', () => {
    const enc = new TextEncoder();
    const sse = (event: string, data: object) => enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

    it('a stream that ends without its `dryrun` event still settles the run (run-watch F6)', async () => {
        statuses.ai1 = [{ status: 'running' }, { status: 'success' }];
        rows.ai1 = [{ stepId: 's1', status: 'success' }];
        let push: (c: Uint8Array) => void = () => {};
        let close: () => void = () => {};
        const body = new ReadableStream<Uint8Array>({ start(c) { push = (x) => c.enqueue(x); close = () => c.close(); } });
        server = runServer((url) => (url.includes('/builder/stream') ? new Response(body, { status: 200 }) : undefined));
        const { result } = renderHook(() => useAutomationBuilderStream({ automationId: 'a1' }));

        let sending: Promise<void> = Promise.resolve();
        await act(async () => { sending = result.current.send({ message: 'build it', modelTier: 'fast' }); await vi.advanceTimersByTimeAsync(0); });
        await act(async () => { push(sse('dryrun_started', { run: { id: 'ai1', status: 'running', startedAt: 't0' } })); await vi.advanceTimersByTimeAsync(0); });
        expect(result.current.state.dryRun).toMatchObject({ id: 'ai1', status: 'running', startedAt: 't0' });

        // The stream ends (a Stop, a gateway cut, a tool error): no `dryrun` event.
        await act(async () => { close(); await sending; });
        expect(result.current.state.running).toBe(false);

        await tick(FOLLOW_RUNNING_MS * 3);
        expect(result.current.state.dryRun).toMatchObject({ id: 'ai1', status: 'success' });
        expect(result.current.state.steps).toEqual(rows.ai1);
        // Followed live, so not replayed.
        expect(result.current.state.dryRunSeq).toBe(0);
    });
});
