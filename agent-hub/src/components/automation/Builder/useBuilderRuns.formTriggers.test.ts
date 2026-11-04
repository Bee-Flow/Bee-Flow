import { act } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderBuilderRuns } from '@/test/builderRunsHarness';
import { HOOK_SAMPLE, PRIMARY_FORM, SECOND_FORM, runDefinition } from '@/test/builderRunsFixtures';

/**
 * RUN-09 and RUN-04: the form declaration and the sample are resolved per
 * trigger id (the primary and every definition.triggers[] entry), and a form
 * opens in Dry run unless it was opened from the confirmed Run live.
 */

afterEach(() => { vi.restoreAllMocks(); });

describe('useBuilderRuns — form triggers', () => {
    it('"Test this form" on a SECONDARY form trigger opens that trigger\'s own form, and its submit names it', async () => {
        const h = renderBuilderRuns(runDefinition());
        await act(async () => { await h.result.current.handleExecuteStep('trg2', { openForm: true }); });
        expect(h.result.current.formTest).toEqual({ form: SECOND_FORM, triggerStepId: 'trg2', mode: 'dry' });
        expect(h.deps.executeStep).not.toHaveBeenCalled();

        // Page one goes through the form's own submission path, so uploads and picks are claimed (studio F8).
        h.deps.api.formTest.mockResolvedValue({ accepted: true, pending: true, runId: 'r1' });
        await act(async () => { await h.result.current.onFormTestRun({ reden: 'x' }, { mode: 'dry' }); });
        expect(h.deps.api.formTest).toHaveBeenCalledWith('a1', { values: { reden: 'x' }, triggerStepId: 'trg2', mode: 'dry', respond: 'created' });
        expect(h.deps.api.dryRun).not.toHaveBeenCalled();
    });

    it('▶ Execute on a bare secondary form trigger opens its form instead of running blind', async () => {
        const h = renderBuilderRuns(runDefinition());
        await act(async () => { await h.result.current.handleExecuteStep('trg2'); });
        expect(h.result.current.formTest).toMatchObject({ form: SECOND_FORM, triggerStepId: 'trg2', mode: 'dry' });
        expect(h.deps.executeStep).not.toHaveBeenCalled();
    });

    it('the header Dry run on a bare form trigger opens the overlay in dry mode and posts nothing', async () => {
        const h = renderBuilderRuns(runDefinition());
        await act(async () => { await h.result.current.onDryRun(); });
        expect(h.result.current.formTest).toEqual({ form: PRIMARY_FORM, triggerStepId: 'trg', mode: 'dry' });
        expect(h.deps.setTab).toHaveBeenCalledWith('build');
        expect(h.deps.api.dryRun).not.toHaveBeenCalled();
    });

    it('a form trigger WITH a saved sample dry-runs with that sample', async () => {
        const h = renderBuilderRuns(runDefinition({ naam: 'Saved' }));
        h.deps.api.dryRun.mockResolvedValue({ accepted: true, pending: true, runId: 'r2' });
        await act(async () => { await h.result.current.onDryRun(); });
        expect(h.result.current.formTest).toBeNull();
        expect(h.deps.api.dryRun).toHaveBeenCalledWith('a1', { triggerPayload: { naam: 'Saved' }, pauses: 'real', respond: 'created' });
    });

    it('▶ Execute on a secondary trigger runs with THAT trigger\'s sample and id; a step with the primary\'s', async () => {
        const h = renderBuilderRuns(runDefinition({ naam: 'Saved' }));
        await act(async () => { await h.result.current.handleExecuteStep('hook'); });
        expect(h.deps.executeStep).toHaveBeenLastCalledWith('hook', { triggerPayload: HOOK_SAMPLE, triggerStepId: 'hook' });
        await act(async () => { await h.result.current.handleExecuteStep('s1'); });
        expect(h.deps.executeStep).toHaveBeenLastCalledWith('s1', { triggerPayload: { naam: 'Saved' } });
    });

    it('Run live on a form trigger confirms once, and the overlay\'s live submit does not ask again', async () => {
        const h = renderBuilderRuns(runDefinition());
        await act(async () => { await h.result.current.onRunLive(); });
        expect(h.deps.confirm).toHaveBeenCalledTimes(1);
        expect(h.result.current.formTest).toEqual({ form: PRIMARY_FORM, triggerStepId: 'trg', mode: 'live', liveConfirmed: true });

        h.rerender({ state: { dryRun: null, steps: [], executingStepId: null } });
        h.deps.api.formTest.mockResolvedValue({ accepted: true, pending: true, runId: 'r3' });
        await act(async () => { await h.result.current.onFormTestRun({ naam: 'Ada' }, { mode: 'live' }); });
        expect(h.deps.confirm).toHaveBeenCalledTimes(1);
        expect(h.deps.api.formTest).toHaveBeenCalledWith('a1', { values: { naam: 'Ada' }, mode: 'live', respond: 'created' });
    });

    it('"Run for real" from a Dry-run overlay asks once per overlay session', async () => {
        const h = renderBuilderRuns(runDefinition());
        await act(async () => { await h.result.current.handleExecuteStep('trg', { openForm: true }); });
        h.deps.api.formTest.mockResolvedValue({ accepted: true, pending: true, runId: 'r4' });
        await act(async () => { await h.result.current.onFormTestRun({ naam: 'A' }, { mode: 'live' }); });
        expect(h.deps.confirm).toHaveBeenCalledTimes(1);
        expect(h.result.current.formTest?.liveConfirmed).toBe(true);
        await act(async () => { await h.result.current.onFormTestRun({ naam: 'B' }, { mode: 'live' }); });
        expect(h.deps.confirm).toHaveBeenCalledTimes(1);

        // A new session asks again.
        act(() => { h.result.current.closeFormTest(); });
        await act(async () => { await h.result.current.handleExecuteStep('trg', { openForm: true }); });
        await act(async () => { await h.result.current.onFormTestRun({ naam: 'C' }, { mode: 'live' }); });
        expect(h.deps.confirm).toHaveBeenCalledTimes(2);
    });

    it('Test step on a step after a bare form nobody answered opens the form in dry mode, bounded to that step', async () => {
        const h = renderBuilderRuns(runDefinition());
        await act(async () => { await h.result.current.handleExecuteStep('s1'); });
        expect(h.result.current.formTest).toEqual({ form: PRIMARY_FORM, triggerStepId: 'trg', mode: 'dry', untilStepId: 's1', untilLabel: 'Mail the customer' });
        expect(h.deps.executeStep).not.toHaveBeenCalled();
        expect(h.deps.setTab).toHaveBeenCalledWith('build');

        // Page one's submit posts the bound with the answers: the dry run ends after s1.
        h.deps.api.formTest.mockResolvedValue({ accepted: true, pending: true, runId: 'r5' });
        await act(async () => { await h.result.current.onFormTestRun({ naam: 'Ada' }, { mode: 'dry' }); });
        expect(h.deps.api.formTest).toHaveBeenCalledWith('a1', { values: { naam: 'Ada' }, mode: 'dry', untilStepId: 's1', respond: 'created' });
        expect(h.deps.api.dryRun).not.toHaveBeenCalled();
    });

    it('"Run up to here" is bounded the same way; "Retry from here" runs the form\'s whole dry run', async () => {
        const h = renderBuilderRuns(runDefinition());
        await act(async () => { await h.result.current.handleExecuteStep('s1', { mode: 'upTo' }); });
        expect(h.result.current.formTest).toMatchObject({ mode: 'dry', untilStepId: 's1' });
        act(() => { h.result.current.closeFormTest(); });
        await act(async () => { await h.result.current.handleRetryFromStep('s1'); });
        expect(h.result.current.formTest).toEqual({ form: PRIMARY_FORM, triggerStepId: 'trg', mode: 'dry' });
        expect(h.deps.executeStep).not.toHaveBeenCalled();
    });

    it('with the answers a run entered the form with, Test step replays them instead of opening the form', async () => {
        const dryRun = { id: 'r9', status: 'success', rootStepId: 'trg', triggerPayload: { naam: 'Ada' } };
        const h = renderBuilderRuns(runDefinition(), { state: { dryRun, steps: [], executingStepId: null } });
        await act(async () => { await h.result.current.handleExecuteStep('s1'); });
        expect(h.result.current.formTest).toBeNull();
        expect(h.deps.executeStep).toHaveBeenCalledWith('s1', { triggerPayload: { naam: 'Ada' } });
    });

    it('a recorded trigger row counts as the answers too; a caller\'s own payload still wins', async () => {
        const steps = [{ stepId: 'trg', status: 'success', output: { naam: 'Row' } }];
        const h = renderBuilderRuns(runDefinition(), { state: { dryRun: null, steps, executingStepId: null } });
        await act(async () => { await h.result.current.handleExecuteStep('s1', { mode: 'upTo' }); });
        expect(h.deps.executeStep).toHaveBeenLastCalledWith('s1', { triggerPayload: { naam: 'Row' }, mode: 'upTo' });
        await act(async () => { await h.result.current.handleExecuteStep('s1', { triggerPayload: { naam: 'Mine' } }); });
        expect(h.deps.executeStep).toHaveBeenLastCalledWith('s1', { triggerPayload: { naam: 'Mine' } });
    });
});

