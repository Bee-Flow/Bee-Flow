import { act, render, renderHook, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import TestRunMenu from './header/TestRunMenu';
import useBuilderHotkeys from './useBuilderHotkeys';
import { renderBuilderRuns } from '@/test/builderRunsHarness';
import { runDefinition } from '@/test/builderRunsFixtures';

/**
 * RUN-12: one run at a time. While a start is in flight, a step executes, the
 * followed run is running or the form overlay is open, the hotkey, the header
 * menu, Dry run and Run live start nothing.
 */

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('run guard — the header menu', () => {
    it('both halves of the split button are disabled while a run is going, and say why', async () => {
        const onDryRun = vi.fn();
        const user = userEvent.setup();
        render(<TestRunMenu runBlocked onDryRun={onDryRun} onRunLive={vi.fn()} />);
        const test = screen.getByRole('button', { name: 'Test' });
        expect(test).toHaveProperty('disabled', true);
        expect(test.getAttribute('title')).toMatch(/A run is going/);
        expect(screen.getByRole('button', { name: 'More ways to run' })).toHaveProperty('disabled', true);
        await user.click(test);
        expect(onDryRun).not.toHaveBeenCalled();
    });

    it('names the two ways to run by what they do', async () => {
        const user = userEvent.setup();
        render(<TestRunMenu onDryRun={vi.fn()} onRunLive={vi.fn()} />);
        await user.click(screen.getByRole('button', { name: 'More ways to run' }));
        expect(screen.getByRole('menuitem', { name: /Dry run \(nothing sent\)/ })).toBeTruthy();
        expect(screen.getByRole('menuitem', { name: /Run live \(test, real actions\)/ })).toBeTruthy();
    });
});

describe('run guard — Cmd/Ctrl + Enter', () => {
    it('starts a dry run when nothing is going, and nothing while a run is', async () => {
        const onDryRun = vi.fn();
        const user = userEvent.setup();
        const { rerender } = renderHook((p: { runBlocked: boolean }) => useBuilderHotkeys({ onDryRun, runBlocked: p.runBlocked }), { initialProps: { runBlocked: true } });
        await user.keyboard('{Control>}{Enter}{/Control}');
        expect(onDryRun).not.toHaveBeenCalled();
        rerender({ runBlocked: false });
        await user.keyboard('{Control>}{Enter}{/Control}');
        expect(onDryRun).toHaveBeenCalledTimes(1);
    });
});

describe('run guard — useBuilderRuns', () => {
    const RUNNING = { dryRun: { id: 'r1', status: 'running' }, steps: [], executingStepId: null };

    it('a followed run that is running blocks Dry run and Run live, and frees them once it pauses', async () => {
        const h = renderBuilderRuns(runDefinition({ naam: 'Saved' }), { state: RUNNING });
        expect(h.result.current.runBlocked).toBe(true);
        await act(async () => { await h.result.current.onDryRun(); await h.result.current.onRunLive(); });
        expect(h.deps.api.dryRun).not.toHaveBeenCalled();
        expect(h.deps.confirm).not.toHaveBeenCalled();

        h.rerender({ state: { ...RUNNING, dryRun: { id: 'r1', status: 'awaiting_form' } } });
        expect(h.result.current.runBlocked).toBe(false);
    });

    it('an executing step, the shell busy flag or an open overlay block too', () => {
        const h = renderBuilderRuns(runDefinition(), { state: { dryRun: null, steps: [], executingStepId: 's1' } });
        expect(h.result.current.runBlocked).toBe(true);
        h.rerender({ state: { dryRun: null, steps: [], executingStepId: null }, busy: true });
        expect(h.result.current.runBlocked).toBe(true);
        h.rerender({ state: { dryRun: null, steps: [], executingStepId: null }, busy: false });
        expect(h.result.current.runBlocked).toBe(false);
        act(() => { h.result.current.openFormOverlay('r9'); });
        expect(h.result.current.runBlocked).toBe(true);
    });

    it('two presses in the same moment start one run', async () => {
        const h = renderBuilderRuns(runDefinition({ naam: 'Saved' }));
        h.deps.api.dryRun.mockResolvedValue({ accepted: true, pending: true, runId: 'r1' });
        await act(async () => { await Promise.all([h.result.current.onDryRun(), h.result.current.onDryRun()]); });
        expect(h.deps.api.dryRun).toHaveBeenCalledTimes(1);
    });
});
