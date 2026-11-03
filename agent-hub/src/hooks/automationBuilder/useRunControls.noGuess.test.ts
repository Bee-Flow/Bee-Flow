import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import useAutomationBuilderStream from '../useAutomationBuilderStream';
import { installRunTransport, json } from '@/test/runTransport';
import { FOLLOW_RUNNING_MS } from './useFollowedRun';

/**
 * run-watch F7: the builder used to discover "the" active run of the
 * automation by polling /_runs/active and taking the first running one, so a
 * scheduled run, a webhook run or somebody else's test showed on the canvas as
 * the author's ▶ Execute. Now the start answers with its own run id and only
 * that id is followed.
 */

let server: ReturnType<typeof installRunTransport>;
const tick = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

beforeEach(() => { vi.useFakeTimers({ shouldAdvanceTime: true }); });
afterEach(() => { server?.uninstall(); vi.useRealTimers(); });

describe('useRunControls — another run of the same automation is never attached', () => {
    it('▶ Execute follows the id its start answered with, while another run of the automation is going', async () => {
        let mine = 0;
        server = installRunTransport((url) => {
            // The other run: running, newest, and in every list the old discovery read.
            if (url.endsWith('/_runs/active')) return json({ active: [{ automationId: 'a1', runId: 'theirs', status: 'running' }] });
            if (url.includes('/a1/runs')) return json({ runs: [{ id: 'theirs', status: 'running' }] });
            if (url.includes('/runs/theirs')) return json({ run: { id: 'theirs', status: 'running' }, steps: [{ stepId: 's9', status: 'running' }] });
            if (url.includes('/steps/s2/run')) return json({ accepted: true, pending: true, runId: 'mine' }, 202);
            if (url.endsWith('/runs/mine')) return json({ run: { id: 'mine', status: (mine += 1) > 1 ? 'success' : 'running' } });
            if (url.endsWith('/runs/mine/steps')) return json({ steps: [{ stepId: 's2', status: 'success', output: { n: 2 } }] });
            return undefined;
        });
        const { result } = renderHook(() => useAutomationBuilderStream({ automationId: 'a1' }));
        act(() => { result.current.setRunResult({ id: 'r0', status: 'success' }, [{ stepId: 's1', status: 'success' }]); });

        const seen = new Set<unknown>();
        await act(async () => { void result.current.executeStep('s2'); });
        for (let i = 0; i < 6; i++) { seen.add(result.current.state.dryRun?.id); await tick(FOLLOW_RUNNING_MS); }

        expect([...seen]).toEqual(['mine']);
        expect(result.current.state.dryRun).toEqual({ id: 'mine', status: 'success' });
        // A partial run merges: s1 keeps its row, s9 (the other run's) never arrives.
        expect(result.current.state.steps.map(s => s.stepId).sort()).toEqual(['s1', 's2']);
        expect(server.urls().some(u => u.includes('/_runs/active') || u.includes('theirs') || u.includes('/a1/runs'))).toBe(false);
        // The request asked for the id at once.
        expect(server.calls.find(c => c.url.includes('/steps/s2/run'))?.body).toEqual({ mode: 'only', respond: 'created' });
    });

    it('a 409 side_effects_need_confirm comes back as needs_confirm, marks nothing failed and starts nothing', async () => {
        server = installRunTransport((url) => (url.includes('/steps/s3/run')
            ? json({
                error: 'Running this step would first run earlier steps that send or write outside the run.',
                code: 'side_effects_need_confirm',
                details: { steps: [{ stepId: 's1', type: 'action', tool: 'gmail_send', label: 'Mail the customer', effect: 'send' }], missingUpstream: ['s1'] },
            }, 409)
            : undefined));
        const { result } = renderHook(() => useAutomationBuilderStream({ automationId: 'a1' }));
        let out: unknown;
        await act(async () => { out = await result.current.executeStep('s3'); });
        expect(out).toEqual({
            kind: 'needs_confirm',
            steps: [{ stepId: 's1', type: 'action', tool: 'gmail_send', label: 'Mail the customer', effect: 'send' }],
            missingUpstream: ['s1'],
        });
        expect(result.current.state.executingStepId).toBeNull();
        expect(result.current.state.error).toBeNull();
        expect(result.current.state.steps).toEqual([]);
        expect(result.current.state.dryRun).toBeNull();
    });
});
