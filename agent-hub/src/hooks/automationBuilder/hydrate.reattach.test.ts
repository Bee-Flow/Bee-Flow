import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import useAutomationBuilderStream from '../useAutomationBuilderStream';
import { installRunTransport, json } from '@/test/runTransport';
import { FOLLOW_PAUSED_MS, FOLLOW_RUNNING_MS } from './useFollowedRun';

/**
 * run-watch F11: a reload in the middle of a test lost the run. The restore
 * returned nothing for a running run, so the canvas never attached, even after
 * it finished. Now my newest run (startedBy=me) is followed again by its id,
 * running or waiting on a form, and settles like any other.
 */

let server: ReturnType<typeof installRunTransport>;
let status: string[];
const tick = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

function serve(run: Record<string, unknown>, steps: unknown[]) {
    server = installRunTransport((url) => {
        if (url.includes('/a1/runs?')) return json({ runs: [run] });
        if (url.endsWith(`/runs/${run.id}/steps`)) return json({ steps });
        if (url.endsWith(`/runs/${run.id}`)) return json({ run: { ...run, status: status.length > 1 ? status.shift() : status[0] } });
        return undefined;
    });
}

beforeEach(() => { vi.useFakeTimers({ shouldAdvanceTime: true }); });
afterEach(() => { server?.uninstall(); vi.useRealTimers(); });

describe('hydrateLastRun — a reload reattaches to my run', () => {
    it('asks for MY newest run only', async () => {
        status = ['success'];
        serve({ id: 'r1', status: 'success' }, [{ stepId: 's1', status: 'success' }]);
        const { result } = renderHook(() => useAutomationBuilderStream({ automationId: 'a1' }));
        await act(async () => { await result.current.hydrateLastRun(); });
        expect(server.urls()[0].endsWith('/api/automation/a1/runs?limit=1&startedBy=me')).toBe(true);
    });

    it('a reload while the run is running follows it until it ends', async () => {
        status = ['running', 'success'];
        serve({ id: 'r1', status: 'running', startedAt: 't0' }, [{ stepId: 's1', status: 'running' }]);
        const { result } = renderHook(() => useAutomationBuilderStream({ automationId: 'a1' }));
        let run: unknown;
        await act(async () => { run = await result.current.hydrateLastRun(); });
        expect(run).toMatchObject({ id: 'r1', status: 'running' });
        expect(result.current.state.dryRun).toMatchObject({ id: 'r1', status: 'running' });
        expect(result.current.state.steps).toEqual([{ stepId: 's1', status: 'running' }]);

        await tick(FOLLOW_RUNNING_MS * 3);
        expect(result.current.state.dryRun).toMatchObject({ id: 'r1', status: 'success' });
    });

    it('a reload while the run waits on a form shows it waiting, and picks it up when it goes on', async () => {
        status = ['awaiting_form'];
        serve({ id: 'r2', status: 'awaiting_form', awaitingStepId: 'fp_2' }, [{ stepId: 'fp_2', status: 'awaiting_form' }]);
        const { result } = renderHook(() => useAutomationBuilderStream({ automationId: 'a1' }));
        await act(async () => { await result.current.hydrateLastRun(); });
        expect(result.current.state.dryRun).toMatchObject({ id: 'r2', status: 'awaiting_form', awaitingStepId: 'fp_2' });
        expect(result.current.state.steps).toEqual([{ stepId: 'fp_2', status: 'awaiting_form' }]);

        // The page is answered in the overlay or elsewhere: the journey ends.
        status = ['success'];
        await tick(FOLLOW_PAUSED_MS + FOLLOW_RUNNING_MS);
        expect(result.current.state.dryRun).toMatchObject({ id: 'r2', status: 'success' });
    });

    it('never writes over a run that started while the restore was reading', async () => {
        status = ['running'];
        serve({ id: 'old', status: 'running' }, [{ stepId: 's1', status: 'running' }]);
        const { result } = renderHook(() => useAutomationBuilderStream({ automationId: 'a1' }));
        act(() => { result.current.setRunResult({ id: 'fresh', status: 'success' }, [{ stepId: 's5', status: 'success' }]); });
        let run: unknown = 'pending';
        await act(async () => { run = await result.current.hydrateLastRun(); });
        expect(run).toBeNull();
        expect(result.current.state.dryRun).toEqual({ id: 'fresh', status: 'success' });
    });
});
