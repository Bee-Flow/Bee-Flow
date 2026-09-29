import { renderHook, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import useAutomationBuilderStream from './useAutomationBuilderStream';
import { authFetch } from '../utils/helpers';

vi.mock('../utils/helpers', () => ({ API_BASE: '', authFetch: vi.fn() }));

/**
 * The AI's dry run is followed LIVE. `dryrun_started` arrives the moment the
 * run's row exists and puts a 'running' stub in `dryRun` — the same shape
 * watchActiveRun makes for a manual run, so BuildTab's `liveRunInFlight`
 * poller lights up the steps as they run. The `dryrun` event that follows
 * replaces the stub with the finished run and its step rows.
 */

const enc = new TextEncoder();
const sse = (event, data) => enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
const flush = () => new Promise((r) => setTimeout(r, 0));

function openBody() {
    let controller;
    const stream = new ReadableStream({ start(c) { controller = c; } });
    return { stream, push: (c) => controller.enqueue(c), close: () => controller.close() };
}

describe('useAutomationBuilderStream — a dry run followed live', () => {
    beforeEach(() => { authFetch.mockReset(); });

    async function start() {
        const body = openBody();
        authFetch.mockImplementation(async () => ({ ok: true, status: 200, body: body.stream }));
        const { result } = renderHook(() => useAutomationBuilderStream({}));
        await act(async () => { result.current.send({ message: 'build it', modelTier: 'fast' }); await flush(); });
        return { result, body };
    }

    it('dryrun_started puts a running stub in dryRun (id + startedAt, no step rows yet)', async () => {
        const { result, body } = await start();
        await act(async () => { body.push(sse('dryrun_started', { run: { id: 'run_1', status: 'running', startedAt: '2026-09-18T10:00:00.000Z' } })); await flush(); });
        expect(result.current.state.dryRun).toEqual({ id: 'run_1', status: 'running', startedAt: '2026-09-18T10:00:00.000Z' });
        expect(result.current.state.steps).toEqual([]);
        expect(result.current.state.dryRunSeq).toBe(0);
    });

    it('the finished dryrun replaces the stub with the real run and its steps — and does not replay a run that was followed live', async () => {
        const { result, body } = await start();
        await act(async () => { body.push(sse('dryrun_started', { run: { id: 'run_1', status: 'running', startedAt: null } })); await flush(); });
        const run = { id: 'run_1', status: 'success', startedAt: 'a', finishedAt: 'b' };
        await act(async () => { body.push(sse('dryrun', { run, steps: [{ stepId: 's1', status: 'success', output: { ok: 1 } }] })); await flush(); });
        expect(result.current.state.dryRun).toEqual(run);
        expect(result.current.state.steps).toHaveLength(1);
        // The canvas showed this run as it happened; a seq bump would make
        // useDryRunReplay act it out a second time.
        expect(result.current.state.dryRunSeq).toBe(0);
    });

    it('a dryrun nobody followed (no dryrun_started — an older server) still replays', async () => {
        const { result, body } = await start();
        const run = { id: 'run_2', status: 'success', startedAt: 'a', finishedAt: 'b' };
        await act(async () => { body.push(sse('dryrun', { run, steps: [{ stepId: 's1', status: 'success' }, { stepId: 's2', status: 'success' }] })); await flush(); });
        expect(result.current.state.dryRun).toEqual(run);
        expect(result.current.state.dryRunSeq).toBe(1);
    });

    it('a second run in the same turn is a new run: the stub carries the new id, the replay stays off', async () => {
        const { result, body } = await start();
        await act(async () => { body.push(sse('dryrun_started', { run: { id: 'run_1', status: 'running' } })); await flush(); });
        await act(async () => { body.push(sse('dryrun', { run: { id: 'run_1', status: 'error' }, steps: [] })); await flush(); });
        await act(async () => { body.push(sse('dryrun_started', { run: { id: 'run_3', status: 'running' } })); await flush(); });
        expect(result.current.state.dryRun).toEqual({ id: 'run_3', status: 'running', startedAt: null });
        expect(result.current.state.steps).toEqual([]);
        await act(async () => { body.push(sse('dryrun', { run: { id: 'run_3', status: 'success' }, steps: [{ stepId: 's1', status: 'success' }] })); await flush(); });
        expect(result.current.state.dryRun.id).toBe('run_3');
        expect(result.current.state.dryRunSeq).toBe(0);
    });
});
