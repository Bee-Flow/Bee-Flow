import { act } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderBuilderRuns } from '@/test/builderRunsHarness';
import { runDefinition } from '@/test/builderRunsFixtures';

/**
 * RM-9 on the client: ▶ Execute after a dry run has no replay data for an
 * earlier step that sends or writes, and the server refuses to run it for real
 * without a yes (409 side_effects_need_confirm). The confirm names those steps
 * as the canvas labels them; yes runs the step again with confirmSideEffects.
 */

const NEEDS = {
    kind: 'needs_confirm' as const,
    steps: [{ stepId: 's1', type: 'action', tool: 'gmail_send', label: 'old label', effect: 'send' }],
    missingUpstream: ['s1'],
};

describe('useBuilderRuns — ▶ Execute that would run earlier steps for real', () => {
    it('asks, naming the steps, and runs again with confirmSideEffects on a yes', async () => {
        const h = renderBuilderRuns(runDefinition({ naam: 'Saved' }));
        h.deps.executeStep.mockResolvedValueOnce(NEEDS);
        await act(async () => { await h.result.current.handleExecuteStep('s2'); });

        expect(h.deps.confirm).toHaveBeenCalledTimes(1);
        const asked = h.deps.confirm.mock.calls[0][0] as { title: string; description: string; destructive?: boolean };
        expect(asked.description).toContain('Mail the customer');
        expect(asked.destructive).toBe(true);
        expect(h.deps.executeStep).toHaveBeenCalledTimes(2);
        expect(h.deps.executeStep).toHaveBeenLastCalledWith('s2', { triggerPayload: { naam: 'Saved' }, confirmSideEffects: true });
    });

    it('a no runs nothing more', async () => {
        const h = renderBuilderRuns(runDefinition());
        h.deps.executeStep.mockResolvedValueOnce(NEEDS);
        h.deps.confirm.mockResolvedValue(false);
        let out: unknown;
        await act(async () => { out = await h.result.current.handleExecuteStep('s2'); });
        expect(out).toEqual(NEEDS);
        expect(h.deps.executeStep).toHaveBeenCalledTimes(1);
    });

    it('Retry from here asks the same way, in mode from', async () => {
        const h = renderBuilderRuns(runDefinition());
        h.deps.executeStep.mockResolvedValueOnce(NEEDS);
        await act(async () => { await h.result.current.handleRetryFromStep('s2'); });
        expect(h.deps.executeStep).toHaveBeenLastCalledWith('s2', { mode: 'from', confirmSideEffects: true });
    });
});
