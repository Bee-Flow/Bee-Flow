import { render, screen, fireEvent, waitFor, act, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ── Mocks ──────────────────────────────────────────────────────────────────
// One hoisted api object (same pattern as useExecutions.test.jsx) so the
// component's useCallback deps stay stable. The three heavy children are
// stubbed down to the props they receive: this file is about what the run
// view FETCHES, DECIDES and HANDS DOWN, not about the canvas.
const { apiMock, timelineProps, canvasProps, approvalProps, streamOpts } = vi.hoisted(() => ({
    apiMock: {},
    timelineProps: { current: null },
    canvasProps: { current: null },
    approvalProps: { current: null },
    streamOpts: { current: null },
}));

vi.mock('../../../../hooks/useAutomationApi', () => ({ default: () => apiMock }));

vi.mock('./RunStepTimeline', () => ({
    default: (props) => {
        timelineProps.current = props;
        return (
            <div
                data-testid="timeline"
                data-count={String(props.steps?.length ?? 0)}
                data-selected={String(props.selectedStepId)}
                data-run-status={String(props.runStatus)}
                data-def-steps={String(props.definition?.steps?.length ?? 0)}
            >
                <button type="button" onClick={() => props.onSelectStep('s2')}>pick s2</button>
                <button type="button" onClick={() => props.onSelectStep(null)}>unpick</button>
            </div>
        );
    },
}));

vi.mock('../../../automation/Builder/RunExecutionView', () => ({
    default: (props) => {
        canvasProps.current = props;
        return (
            <div
                data-testid="canvas"
                data-empty={String(props.emptyDefinitionMessage)}
                data-steps={String(props.steps?.length ?? 0)}
                data-selected={String(props.selectedStepId)}
                data-has-definition={String(!!props.definition)}
            />
        );
    },
}));

vi.mock('../../../automation/Builder/approvals/ApprovalActionBar', () => ({
    default: (props) => {
        approvalProps.current = props;
        return (
            <div
                data-testid="approval"
                data-run={String(props.runId)}
                data-step={String(props.stepId)}
                data-fields={JSON.stringify(props.fields ?? null)}
            >
                <span data-testid="approval-prompt">{props.prompt}</span>
                <button type="button" onClick={() => props.onResolved('approve')}>resolve approve</button>
                <button type="button" onClick={() => props.onResolved('reject')}>resolve reject</button>
            </div>
        );
    },
}));

vi.mock('./useRunStream', () => ({
    default: (opts) => { streamOpts.current = opts; return { state: 'live' }; },
}));

import ExecutionView from './ExecutionView';

/**
 * CHARACTERISATION — the full-screen run view as it behaves today.
 *
 * Pinned here: what it asks the server for, how it survives (or fails to
 * survive) each of those requests going wrong, which live events it acts on,
 * and which of the two approval gates it answers. Several of these pins
 * describe behaviour that is plainly wrong today; those names say so.
 */

const RUN = {
    id: 'r1',
    automationId: 'a1',
    status: 'success',
    mode: 'live',
    startedAt: '2026-08-12T14:03:00.000Z',
    durationMs: 1200,
};

const STEPS = {
    steps: [
        { runId: 'r1', stepId: 's1', status: 'success', durationMs: 100 },
        { runId: 'r1', stepId: 's2', status: 'success', durationMs: 200 },
    ],
    definition: { steps: [{ id: 's1', label: 'First' }, { id: 's2', label: 'Second' }] },
};

const view = (props = {}) => render(
    <ExecutionView
        runId="r1"
        onBack={vi.fn()}
        onOpenEditor={vi.fn()}
        {...props}
    />,
);

/** Render and wait until the initial two requests have settled. */
const loaded = async (props = {}) => {
    const rendered = view(props);
    await waitFor(() => expect(apiMock.getRun).toHaveBeenCalled());
    await waitFor(() => expect(apiMock.getRunSteps).toHaveBeenCalled());
    await act(async () => {
        await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    });
    return rendered;
};

beforeEach(() => {
    cleanup();
    timelineProps.current = null;
    canvasProps.current = null;
    approvalProps.current = null;
    streamOpts.current = null;
    apiMock.getRun = vi.fn().mockResolvedValue(RUN);
    apiMock.getRunSteps = vi.fn().mockResolvedValue(STEPS);
    apiMock.retryRun = vi.fn().mockResolvedValue({});
    apiMock.cancelRun = vi.fn().mockResolvedValue({});
    apiMock.approveRun = vi.fn().mockResolvedValue({});
    apiMock.approveStep = vi.fn().mockResolvedValue({});
});

// ── the happy path ──────────────────────────────────────────────────────────
describe('ExecutionView — loading one run', () => {
    it('asks for the run and its steps, once each, for the id it was given', async () => {
        await loaded();
        expect(apiMock.getRun).toHaveBeenCalledTimes(1);
        expect(apiMock.getRun).toHaveBeenCalledWith('r1');
        expect(apiMock.getRunSteps).toHaveBeenCalledTimes(1);
        expect(apiMock.getRunSteps).toHaveBeenCalledWith('r1');
    });

    it('hands the same steps and versioned definition to BOTH the timeline and the canvas', async () => {
        await loaded();
        expect(screen.getByTestId('timeline').getAttribute('data-count')).toBe('2');
        expect(screen.getByTestId('timeline').getAttribute('data-def-steps')).toBe('2');
        expect(screen.getByTestId('canvas').getAttribute('data-steps')).toBe('2');
        expect(screen.getByTestId('canvas').getAttribute('data-has-definition')).toBe('true');
        expect(timelineProps.current.steps).toBe(canvasProps.current.steps);
        expect(timelineProps.current.definition).toBe(canvasProps.current.definition);
    });

    it('tells the timeline which run status it is drawing', async () => {
        apiMock.getRun.mockResolvedValue({ ...RUN, status: 'error' });
        await loaded();
        expect(screen.getByTestId('timeline').getAttribute('data-run-status')).toBe('error');
    });

    it('says "Loading the run…" on the canvas first, then "Definition unavailable" when none came back', async () => {
        apiMock.getRunSteps.mockResolvedValue({ steps: [], definition: null });
        view();
        expect(screen.getByTestId('canvas').getAttribute('data-empty')).toBe('Loading the run…');
        await waitFor(() => expect(screen.getByTestId('canvas').getAttribute('data-empty'))
            .toBe('Definition unavailable for this run.'));
        expect(screen.getByTestId('canvas').getAttribute('data-has-definition')).toBe('false');
    });

    it('treats a steps payload with neither key as an empty run rather than crashing', async () => {
        apiMock.getRunSteps.mockResolvedValue({});
        await loaded();
        expect(screen.getByTestId('timeline').getAttribute('data-count')).toBe('0');
    });

    it('paints the bar from the seed row before the fetch lands', async () => {
        let release;
        apiMock.getRun = vi.fn(() => new Promise((res) => { release = res; }));
        view({ run: { id: 'r1', automationId: 'a1' } });
        // runTitle of a seed with no startedAt.
        expect(screen.getByText('Run r1')).toBeTruthy();
        expect(screen.queryByText('Loading the run…')).toBeNull();
        await act(async () => { release(RUN); });
    });

    it('ignores a seed that belongs to a different run', async () => {
        let release;
        apiMock.getRun = vi.fn(() => new Promise((res) => { release = res; }));
        view({ run: { id: 'someone-else', automationId: 'a1' } });
        expect(screen.getByText('Loading the run…')).toBeTruthy();
        await act(async () => { release(RUN); });
    });

    it('MERGES the fetched run over the seed — fields the server omits survive', async () => {
        const onOpenEditor = vi.fn();
        // The server answer has no automationId; the seed row did.
        apiMock.getRun.mockResolvedValue({ id: 'r1', status: 'success', startedAt: RUN.startedAt });
        await loaded({ run: { id: 'r1', automationId: 'seeded-a' }, onOpenEditor });
        const btn = screen.getByRole('button', { name: /Open in editor/ });
        expect(btn.disabled).toBe(false);
        fireEvent.click(btn);
        expect(onOpenEditor).toHaveBeenCalledWith('seeded-a');
    });
});

// ── failure paths ───────────────────────────────────────────────────────────
describe('ExecutionView — when a request fails', () => {
    it('offers a way out when the run itself cannot be loaded', async () => {
        apiMock.getRun.mockRejectedValue(new Error('boom'));
        view();
        await screen.findByText("We couldn't load this run.");
        expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
        expect(screen.getByRole('button', { name: 'Back to Runs' })).toBeTruthy();
        // The whole run surface is replaced — no bar, no timeline, no canvas.
        expect(screen.queryByTestId('timeline')).toBeNull();
        expect(screen.queryByTestId('canvas')).toBeNull();
    });

    it('"Try again" refetches both the run and the steps', async () => {
        apiMock.getRun.mockRejectedValue(new Error('boom'));
        view();
        await screen.findByText("We couldn't load this run.");
        apiMock.getRun.mockResolvedValue(RUN);
        fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
        await waitFor(() => expect(screen.queryByText("We couldn't load this run.")).toBeNull());
        expect(apiMock.getRun).toHaveBeenCalledTimes(2);
        expect(apiMock.getRunSteps).toHaveBeenCalledTimes(2);
    });

    it('"Back to Runs" on the failure screen calls onBack', async () => {
        const onBack = vi.fn();
        apiMock.getRun.mockRejectedValue(new Error('boom'));
        view({ onBack });
        await screen.findByText("We couldn't load this run.");
        fireEvent.click(screen.getByRole('button', { name: 'Back to Runs' }));
        expect(onBack).toHaveBeenCalledTimes(1);
    });

    it('keeps showing the STALE seed row when the refetch fails, and says nothing (wrat)', async () => {
        // loadError only reaches the screen when there is no run at all, so a
        // deep-linked row that fails to refresh silently keeps whatever the
        // list happened to know.
        apiMock.getRun.mockRejectedValue(new Error('boom'));
        view({ run: { id: 'r1', automationId: 'a1', status: 'running' } });
        await waitFor(() => expect(apiMock.getRun).toHaveBeenCalled());
        expect(screen.queryByText("We couldn't load this run.")).toBeNull();
        expect(screen.getByText('Run r1')).toBeTruthy();
        expect(screen.queryByRole('alert')).toBeNull();
        expect(document.querySelector('[data-testid="run-status-badge"]').textContent).toBe('Running');
    });

    it('a failed STEPS request reads exactly like a run that recorded no steps (wrat)', async () => {
        apiMock.getRunSteps.mockRejectedValue(new Error('nope'));
        await loaded();
        expect(screen.getByTestId('timeline').getAttribute('data-count')).toBe('0');
        expect(screen.getByTestId('canvas').getAttribute('data-has-definition')).toBe('false');
        expect(screen.queryByText("We couldn't load this run.")).toBeNull();
        expect(screen.queryByRole('alert')).toBeNull();
    });

    it('keeps the last good steps when a later steps fetch fails', async () => {
        await loaded();
        apiMock.getRunSteps.mockRejectedValue(new Error('nope'));
        await act(async () => { await streamOpts.current.onEvent('run.finished', { runId: 'r1' }); });
        await waitFor(() => expect(apiMock.getRun).toHaveBeenCalledTimes(2));
        // The steps refetch is debounced by 750ms: waiting only for getRun
        // asserted the old data BEFORE the failing fetch was even made, so the
        // catch was never exercised. Wait for the second getRunSteps first.
        await waitFor(() => expect(apiMock.getRunSteps).toHaveBeenCalledTimes(2), { timeout: 3000 });
        expect(screen.getByTestId('timeline').getAttribute('data-count')).toBe('2');
    });

    it('says why the run stopped in plain words, the raw message behind "technical message"', async () => {
        // The banner used to print the server's raw message as the reason.
        apiMock.getRun.mockResolvedValue({
            ...RUN, status: 'error', error: '550 5.1.1 Recipient address rejected',
            outcome: { code: 'stopped_at', params: { step: 'Post to finance', reasonCode: 'validation', reason: 'a setting has a value this step cannot use' } },
        });
        await loaded();
        const banner = screen.getByTestId('run-problem-banner');
        expect(banner.textContent).toContain('Stopped at "Post to finance": a setting has a value this step cannot use');
        expect(screen.queryByText('550 5.1.1 Recipient address rejected')).toBeNull();
        await userEvent.click(screen.getByRole('button', { name: 'technical message' }));
        expect(screen.getByText('550 5.1.1 Recipient address rejected')).toBeTruthy();
    });
});

// ── live updates ────────────────────────────────────────────────────────────
describe('ExecutionView — live updates', () => {
    it('subscribes only while the run is running, scoped to its automation', async () => {
        apiMock.getRun.mockResolvedValue({ ...RUN, status: 'running' });
        await loaded();
        expect(streamOpts.current.enabled).toBe(true);
        expect(streamOpts.current.automationId).toBe('a1');
    });

    it('does not subscribe for a finished run', async () => {
        await loaded();
        expect(streamOpts.current.enabled).toBe(false);
    });

    it('does not subscribe while the panel is not the visible view', async () => {
        apiMock.getRun.mockResolvedValue({ ...RUN, status: 'running' });
        await loaded({ active: false });
        expect(streamOpts.current.enabled).toBe(false);
    });

    it('ignores events belonging to another run', async () => {
        await loaded();
        await act(async () => { await streamOpts.current.onEvent('run.finished', { runId: 'someone-else' }); });
        expect(apiMock.getRun).toHaveBeenCalledTimes(1);
        expect(apiMock.getRunSteps).toHaveBeenCalledTimes(1);
    });

    it('accepts an event with NO runId as if it were this run (wrat)', async () => {
        await loaded();
        await act(async () => { await streamOpts.current.onEvent('run.finished', { status: 'success' }); });
        await waitFor(() => expect(apiMock.getRun).toHaveBeenCalledTimes(2));
    });

    it('reloads the run AND the steps on run.failed', async () => {
        await loaded();
        await act(async () => { await streamOpts.current.onEvent('run.failed', { runId: 'r1' }); });
        await waitFor(() => expect(apiMock.getRun).toHaveBeenCalledTimes(2));
    });
});

describe('ExecutionView — refetch timing', () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });

    const settle = async (ms = 0) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };

    it('collapses a burst of step events into ONE steps fetch per 750ms window', async () => {
        apiMock.getRun.mockResolvedValue({ ...RUN, status: 'running' });
        view();
        await settle();
        expect(apiMock.getRunSteps).toHaveBeenCalledTimes(1); // the initial load
        await act(async () => {
            streamOpts.current.onEvent('step.started', { runId: 'r1', stepId: 's1' });
            streamOpts.current.onEvent('step.finished', { runId: 'r1', stepId: 's1' });
            streamOpts.current.onEvent('step.started', { runId: 'r1', stepId: 's2' });
        });
        await settle(749);
        expect(apiMock.getRunSteps).toHaveBeenCalledTimes(1);
        await settle(1);
        expect(apiMock.getRunSteps).toHaveBeenCalledTimes(2);
    });

    it('polls the steps every 1.5s while the run is running', async () => {
        apiMock.getRun.mockResolvedValue({ ...RUN, status: 'running' });
        view();
        await settle();
        expect(apiMock.getRunSteps).toHaveBeenCalledTimes(1);
        await settle(1500 + 750);
        expect(apiMock.getRunSteps).toHaveBeenCalledTimes(2);
        await settle(1500 + 750);
        expect(apiMock.getRunSteps).toHaveBeenCalledTimes(3);
    });

    it('polls for a queued run too', async () => {
        apiMock.getRun.mockResolvedValue({ ...RUN, status: 'queued' });
        view();
        await settle();
        await settle(2250);
        expect(apiMock.getRunSteps).toHaveBeenCalledTimes(2);
    });

    it('does not poll a finished run, nor an inactive panel', async () => {
        view();
        await settle();
        await settle(10_000);
        expect(apiMock.getRunSteps).toHaveBeenCalledTimes(1);

        cleanup();
        apiMock.getRunSteps.mockClear();
        apiMock.getRun.mockResolvedValue({ ...RUN, status: 'running' });
        view({ active: false });
        await settle();
        await settle(10_000);
        expect(apiMock.getRunSteps).toHaveBeenCalledTimes(1);
    });
});

// ── the actions the bar delegates here ──────────────────────────────────────
describe('ExecutionView — retry, cancel and the run-level confirm', () => {
    it('retries against the run\'s automation and OPENS the child run the server started', async () => {
        const onOpenAnotherRun = vi.fn();
        apiMock.getRun.mockResolvedValue({ ...RUN, status: 'error' });
        apiMock.retryRun.mockResolvedValue({ run: { id: 'child-1' } });
        await loaded({ onOpenAnotherRun });
        fireEvent.click(screen.getByRole('button', { name: /Run it again/ }));
        await waitFor(() => expect(onOpenAnotherRun).toHaveBeenCalledWith('child-1'));
        expect(apiMock.retryRun).toHaveBeenCalledWith('a1', 'r1');
    });

    it('falls back to an inline notice when the retry answers without a child run', async () => {
        apiMock.getRun.mockResolvedValue({ ...RUN, status: 'error' });
        apiMock.retryRun.mockResolvedValue({});
        await loaded({ onOpenAnotherRun: vi.fn() });
        fireEvent.click(screen.getByRole('button', { name: /Run it again/ }));
        await screen.findByText("Started — it's running now");
        await waitFor(() => expect(apiMock.getRun).toHaveBeenCalledTimes(2));
    });

    it('leaves that notice on screen forever, even after the run reloads (wrat)', async () => {
        apiMock.getRun.mockResolvedValue({ ...RUN, status: 'error' });
        apiMock.retryRun.mockResolvedValue({});
        await loaded({ onOpenAnotherRun: vi.fn() });
        fireEvent.click(screen.getByRole('button', { name: /Run it again/ }));
        await screen.findByText("Started — it's running now");
        await act(async () => { await streamOpts.current.onEvent('run.finished', { runId: 'r1' }); });
        await waitFor(() => expect(apiMock.getRun).toHaveBeenCalledTimes(3));
        expect(screen.getByText("Started — it's running now")).toBeTruthy();
    });

    it('retries with an UNDEFINED automation id when the run carries none (wrat)', async () => {
        apiMock.getRun.mockResolvedValue({ id: 'r1', status: 'error', startedAt: RUN.startedAt });
        apiMock.retryRun.mockResolvedValue({ run: { id: 'child-1' } });
        await loaded({ onOpenAnotherRun: vi.fn() });
        fireEvent.click(screen.getByRole('button', { name: /Run it again/ }));
        await waitFor(() => expect(apiMock.retryRun).toHaveBeenCalledWith(undefined, 'r1'));
    });

    it('cancels the run and reloads it', async () => {
        apiMock.getRun.mockResolvedValue({ ...RUN, status: 'running' });
        await loaded();
        fireEvent.click(screen.getByRole('button', { name: /Stop it/ }));
        await waitFor(() => expect(apiMock.cancelRun).toHaveBeenCalledWith('r1'));
        await waitFor(() => expect(apiMock.getRun).toHaveBeenCalledTimes(2));
    });

    it('approves awaiting_confirm at RUN level (approveRun "approve"), never as a step decision', async () => {
        apiMock.getRun.mockResolvedValue({ ...RUN, status: 'awaiting_confirm' });
        await loaded();
        fireEvent.click(screen.getByRole('button', { name: /Approve/ }));
        await waitFor(() => expect(apiMock.approveRun).toHaveBeenCalledWith('r1', 'approve'));
        expect(apiMock.approveStep).not.toHaveBeenCalled();
        await waitFor(() => expect(apiMock.getRun).toHaveBeenCalledTimes(2));
    });

    it('DECLINES a run-level first-run confirm — approveRun gets "reject", not an approval', async () => {
        // Reject reaches the server as a reject: the run is closed and the
        // automation's confirm gate stays on. The branch used to drop the word
        // and call approveRun bare, which the server read as an approval —
        // the one button whose job is to say "no" ran the automation and took
        // the gate off for good.
        apiMock.getRun.mockResolvedValue({ ...RUN, status: 'awaiting_confirm' });
        await loaded();
        fireEvent.click(screen.getByRole('button', { name: /Reject/ }));
        await waitFor(() => expect(apiMock.approveRun).toHaveBeenCalledWith('r1', 'reject'));
        expect(apiMock.approveStep).not.toHaveBeenCalled();
        await waitFor(() => expect(apiMock.getRun).toHaveBeenCalledTimes(2));
    });
});

// ── the step-level approval panel ───────────────────────────────────────────
describe('ExecutionView — the awaiting-approval panel', () => {
    const awaiting = { ...RUN, status: 'awaiting_approval' };
    const pausedSteps = {
        steps: [
            { runId: 'r1', stepId: 's1', status: 'success' },
            { runId: 'r1', stepId: 's2', status: 'awaiting_approval', output: { prompt: 'Send this email?' } },
        ],
        definition: {
            steps: [
                { id: 's1', label: 'First' },
                { id: 's2', label: 'Second', prompt: 'raw definition prompt', approval: { fields: [{ name: 'why' }] } },
            ],
        },
    };

    it('mounts the decision surface for the paused step, with the RECORDED question', async () => {
        apiMock.getRun.mockResolvedValue(awaiting);
        apiMock.getRunSteps.mockResolvedValue(pausedSteps);
        await loaded();
        const panel = screen.getByTestId('approval');
        expect(panel.getAttribute('data-run')).toBe('r1');
        expect(panel.getAttribute('data-step')).toBe('s2');
        expect(screen.getByTestId('approval-prompt').textContent).toBe('Send this email?');
        expect(JSON.parse(panel.getAttribute('data-fields'))).toEqual([{ name: 'why' }]);
    });

    it('prefers the journey run id when the row carries one', async () => {
        apiMock.getRun.mockResolvedValue({ ...awaiting, journeyRunId: 'journey-7' });
        apiMock.getRunSteps.mockResolvedValue(pausedSteps);
        await loaded();
        expect(screen.getByTestId('approval').getAttribute('data-run')).toBe('journey-7');
    });

    it('falls back to the definition prompt, then to an empty string', async () => {
        apiMock.getRun.mockResolvedValue(awaiting);
        apiMock.getRunSteps.mockResolvedValue({
            ...pausedSteps,
            steps: [{ runId: 'r1', stepId: 's2', status: 'awaiting_approval', output: {} }],
        });
        await loaded();
        expect(screen.getByTestId('approval-prompt').textContent).toBe('raw definition prompt');

        cleanup();
        apiMock.getRunSteps.mockResolvedValue({
            steps: [{ runId: 'r1', stepId: 'unknown-step', status: 'awaiting_approval', output: null }],
            definition: { steps: [] },
        });
        await loaded();
        expect(screen.getByTestId('approval-prompt').textContent).toBe('');
    });

    it('passes null fields when the snapshot declares none (or something that is not a list)', async () => {
        apiMock.getRun.mockResolvedValue(awaiting);
        apiMock.getRunSteps.mockResolvedValue({
            steps: [{ runId: 'r1', stepId: 's2', status: 'awaiting_approval', output: { prompt: 'q' } }],
            definition: { steps: [{ id: 's2', approval: { fields: 'not-a-list' } }] },
        });
        await loaded();
        expect(JSON.parse(screen.getByTestId('approval').getAttribute('data-fields'))).toBeNull();
    });

    it('leaves the user with NO way to decide when no step row is paused (wrat)', async () => {
        // The bar dropped its approve/reject for awaiting_approval on purpose
        // (a rejection needs a reason), and the panel only mounts when a step
        // row says awaiting_approval. If the run says it but the rows do not —
        // an unloaded, stale or failed steps fetch — the screen offers nothing.
        apiMock.getRun.mockResolvedValue(awaiting);
        apiMock.getRunSteps.mockResolvedValue({ steps: [{ runId: 'r1', stepId: 's1', status: 'success' }], definition: null });
        await loaded();
        expect(screen.queryByTestId('approval')).toBeNull();
        expect(screen.queryByRole('button', { name: /Approve/ })).toBeNull();
        expect(screen.queryByRole('button', { name: /Reject/ })).toBeNull();
    });

    it('after an approval, reloads and opens the continuation run', async () => {
        const onOpenAnotherRun = vi.fn();
        apiMock.getRun.mockResolvedValue({ ...awaiting, journeyRunId: 'child-9' });
        apiMock.getRunSteps.mockResolvedValue(pausedSteps);
        await loaded({ onOpenAnotherRun });
        fireEvent.click(screen.getByRole('button', { name: 'resolve approve' }));
        await waitFor(() => expect(onOpenAnotherRun).toHaveBeenCalledWith('child-9'));
    });

    it('after a rejection, only reloads — it never navigates', async () => {
        const onOpenAnotherRun = vi.fn();
        apiMock.getRun.mockResolvedValue({ ...awaiting, journeyRunId: 'child-9' });
        apiMock.getRunSteps.mockResolvedValue(pausedSteps);
        await loaded({ onOpenAnotherRun });
        fireEvent.click(screen.getByRole('button', { name: 'resolve reject' }));
        await waitFor(() => expect(apiMock.getRun).toHaveBeenCalledTimes(2));
        expect(onOpenAnotherRun).not.toHaveBeenCalled();
    });

    it('swallows a failed re-read after an approval instead of navigating anywhere', async () => {
        const onOpenAnotherRun = vi.fn();
        apiMock.getRun
            .mockResolvedValueOnce({ ...awaiting, journeyRunId: 'child-9' })
            .mockResolvedValueOnce({ ...awaiting, journeyRunId: 'child-9' })
            .mockRejectedValueOnce(new Error('gone'));
        apiMock.getRunSteps.mockResolvedValue(pausedSteps);
        await loaded({ onOpenAnotherRun });
        fireEvent.click(screen.getByRole('button', { name: 'resolve approve' }));
        await waitFor(() => expect(apiMock.getRun).toHaveBeenCalledTimes(3));
        expect(onOpenAnotherRun).not.toHaveBeenCalled();
    });
});

// ── step selection ──────────────────────────────────────────────────────────
describe('ExecutionView — the selected step', () => {
    it('starts at initialStepId and hands it to both panes', async () => {
        await loaded({ initialStepId: 's1' });
        expect(screen.getByTestId('timeline').getAttribute('data-selected')).toBe('s1');
        expect(screen.getByTestId('canvas').getAttribute('data-selected')).toBe('s1');
    });

    it('selecting in the timeline moves the canvas and reports the id upwards', async () => {
        const onSelectStep = vi.fn();
        await loaded({ onSelectStep });
        fireEvent.click(screen.getByRole('button', { name: 'pick s2' }));
        expect(onSelectStep).toHaveBeenCalledWith('s2');
        expect(screen.getByTestId('canvas').getAttribute('data-selected')).toBe('s2');
    });

    it('reports a cleared selection as null', async () => {
        const onSelectStep = vi.fn();
        await loaded({ onSelectStep, initialStepId: 's1' });
        fireEvent.click(screen.getByRole('button', { name: 'unpick' }));
        expect(onSelectStep).toHaveBeenCalledWith(null);
        expect(screen.getByTestId('timeline').getAttribute('data-selected')).toBe('null');
    });

    it('adopts a changed initialStepId (Back/Forward) without reporting it back', async () => {
        const onSelectStep = vi.fn();
        const { rerender } = await loaded({ onSelectStep, initialStepId: 's1' });
        rerender(<ExecutionView runId="r1" onBack={vi.fn()} onOpenEditor={vi.fn()} onSelectStep={onSelectStep} initialStepId="s2" />);
        expect(screen.getByTestId('timeline').getAttribute('data-selected')).toBe('s2');
        expect(onSelectStep).not.toHaveBeenCalled();
    });
});
