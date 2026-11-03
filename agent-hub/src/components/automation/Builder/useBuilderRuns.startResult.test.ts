import { act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toast } from '@/components/shared/Toast';
import { renderBuilderRuns } from '@/test/builderRunsHarness';
import { runDefinition } from '@/test/builderRunsFixtures';

/**
 * RUN-03, studio-and-forms F2, tests-and-docs F6: a start answers with what
 * happened (declined, skipped, or started with the id to follow), and nothing
 * says a run finished before its run row says so. The overlay's page one
 * goes through POST /:id/form-test (api.formTest), the form's own submission path.
 */

const ANSWERS = { naam: 'Ada' };
let success: ReturnType<typeof vi.spyOn>;
let info: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
    success = vi.spyOn(toast, 'success').mockImplementation(() => 0 as never);
    info = vi.spyOn(toast, 'info').mockImplementation(() => 0 as never);
});
afterEach(() => { vi.restoreAllMocks(); });

describe('useBuilderRuns — the overlay\'s start result', () => {
    it('declined: the Run live confirm said no, and nothing was sent', async () => {
        const h = renderBuilderRuns(runDefinition());
        h.deps.confirm.mockResolvedValue(false);
        let out: unknown;
        await act(async () => { out = await h.result.current.onFormTestRun(ANSWERS, { mode: 'live' }); });
        expect(out).toEqual({ kind: 'declined' });
        expect(h.deps.api.formTest).not.toHaveBeenCalled();
        expect(h.deps.followRun).not.toHaveBeenCalled();
    });

    it('skipped: the server had nothing to run, and says why', async () => {
        const h = renderBuilderRuns(runDefinition());
        h.deps.api.formTest.mockResolvedValue({ accepted: true, pending: false, skipped: true, message: 'No sample yet.' });
        let out: unknown;
        await act(async () => { out = await h.result.current.onFormTestRun(ANSWERS, { mode: 'dry' }); });
        expect(out).toEqual({ kind: 'skipped', message: 'No sample yet.' });
        expect(h.deps.followRun).not.toHaveBeenCalled();
        expect(info).toHaveBeenCalledWith('No sample yet.');
    });

    it('started: a dry run pauses for real, answers with its id, and is followed by that id', async () => {
        const h = renderBuilderRuns(runDefinition());
        h.deps.api.formTest.mockResolvedValue({ accepted: true, pending: true, runId: 'r1' });
        let out: unknown;
        await act(async () => { out = await h.result.current.onFormTestRun(ANSWERS, { mode: 'dry' }); });
        expect(out).toEqual({ kind: 'started', runId: 'r1' });
        expect(h.deps.api.formTest).toHaveBeenCalledWith('a1', { values: ANSWERS, mode: 'dry', respond: 'created' });
        expect(h.deps.followRun).toHaveBeenCalledWith('r1', { kind: 'full' });
        // The run is going: no word about it being over.
        expect(success).not.toHaveBeenCalled();

        await act(async () => { h.settleFollow({ run: { id: 'r1', status: 'success', mode: 'dry_run' }, steps: [] }); });
        expect(success).toHaveBeenCalledWith('Dry run finished. Open a step to see its output.');
    });

    it('a live start is a test run of the working copy, and a pause is not reported as finished', async () => {
        const h = renderBuilderRuns(runDefinition());
        h.deps.api.formTest.mockResolvedValue({ accepted: true, pending: true, runId: 'r2' });
        await act(async () => { await h.result.current.onFormTestRun(ANSWERS, { mode: 'live' }); });
        expect(h.deps.api.formTest).toHaveBeenCalledWith('a1', { values: ANSWERS, mode: 'live', respond: 'created' });

        await act(async () => {
            h.settleFollow({ run: { id: 'r2', status: 'awaiting_form', awaitingStepId: 'fp', profile: { kind: 'test' } }, steps: [{ stepId: 'fp', status: 'awaiting_form' }] });
        });
        expect(success).not.toHaveBeenCalled();
        expect(info).toHaveBeenCalled();
    });

    it('a follow replaced before the run settled shows nothing', async () => {
        const h = renderBuilderRuns(runDefinition());
        h.deps.api.formTest.mockResolvedValue({ accepted: true, pending: true, runId: 'r3' });
        await act(async () => { await h.result.current.onFormTestRun(ANSWERS, { mode: 'dry' }); });
        await act(async () => { h.settleFollow(null); });
        expect(success).not.toHaveBeenCalled();
        expect(info).not.toHaveBeenCalled();
    });

    it('a run that answered already over is shown at once, not followed', async () => {
        const h = renderBuilderRuns(runDefinition());
        h.deps.api.formTest.mockResolvedValue({ run: { id: 'r4', status: 'error', mode: 'dry_run' }, steps: [] });
        let out: unknown;
        await act(async () => { out = await h.result.current.onFormTestRun(ANSWERS, { mode: 'dry' }); });
        expect(out).toEqual({ kind: 'started', runId: 'r4' });
        expect(h.deps.setRunResult).toHaveBeenCalledWith({ id: 'r4', status: 'error', mode: 'dry_run' }, []);
        expect(h.deps.followRun).not.toHaveBeenCalled();
        expect(success).not.toHaveBeenCalled();
    });

    it('a refused start throws to the overlay and leaves the shell error set', async () => {
        const h = renderBuilderRuns(runDefinition());
        h.deps.api.formTest.mockRejectedValue(Object.assign(new Error('Add a trigger first.'), { status: 400 }));
        await act(async () => {
            await expect(h.result.current.onFormTestRun(ANSWERS, { mode: 'dry' })).rejects.toThrow('Add a trigger first.');
        });
        expect(h.deps.setError).toHaveBeenLastCalledWith('Add a trigger first.');
        expect(h.deps.setBusy).toHaveBeenLastCalledWith(false);
    });
});
