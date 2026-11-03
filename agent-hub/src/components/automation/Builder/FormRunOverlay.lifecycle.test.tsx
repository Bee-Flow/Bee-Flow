/**
 * The overlay's lifecycle (RUN-11): closed while the run still goes, it tells
 * the shell so the run's next page does not pop it up again; a run that keeps
 * going past the follow budget, or can no longer be read, ends in "still
 * running", never a spinner forever; a click beside a typed page asks first;
 * Esc and the close button close; a parked test run is kept waiting or
 * discarded.
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React, { type ComponentProps } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { withQueryClient } from '@/test/queryWrapper';
import { fakeServer, type FakeReply } from '@/test/formRunServer';
import FormRunOverlay from './FormRunOverlay';
import { recordDismissal, shouldAutoOpenFormOverlay } from './flow/formOverlayAutoOpen';
import type { FormRunCloseInfo } from './formRunContract';

const FORM = {
    title: 'Request', description: '', submitLabel: 'Send', successMessage: 'Thanks', theme: {},
    fields: [{ name: 'city', type: 'text', label: 'City', required: true, placeholder: '', help: '' }],
};
const PAGE_TWO = { ...FORM, title: 'Page two', submitLabel: 'Continue', fields: [{ name: 'zip', type: 'text', label: 'Zip', required: true, placeholder: '', help: '' }] };

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

/** GET /runs/:id/form answers `reply` (a function of the read count); POST /cancel is accepted. */
function serve(reply: (reads: number) => FakeReply) {
    let reads = 0;
    return fakeServer((call) => {
        if (call.method === 'GET' && /\/runs\/\w+\/form$/.test(call.path)) return reply(++reads);
        if (call.method === 'POST' && call.path.endsWith('/cancel')) return { status: 202, body: { accepted: true } };
        return null;
    });
}

function renderOverlay(props: Partial<ComponentProps<typeof FormRunOverlay>> = {}) {
    const onClose = vi.fn<(info?: FormRunCloseInfo) => void>();
    const onStartRun = vi.fn(async () => ({ kind: 'started' as const, runId: 'r1' }));
    render(withQueryClient(<FormRunOverlay automationId="a1" form={FORM} onStartRun={onStartRun} onClose={onClose} {...props} />));
    return { onClose, onStartRun };
}

const running: FakeReply = { body: { runId: 'r1', status: 'running', waiting: false } };

describe('FormRunOverlay — closing while the run goes', () => {
    it('records a run-level dismissal, so the run\'s next page does not reopen the overlay', async () => {
        const user = userEvent.setup();
        serve(() => running);
        const { onClose } = renderOverlay({ followTiming: { intervalMs: 20 } });
        await user.type(screen.getByLabelText(/City/), 'Utrecht');
        await user.click(screen.getByRole('button', { name: 'Send' }));
        expect(await screen.findByText('Running the automation…')).toBeTruthy();

        await user.click(screen.getByRole('button', { name: 'Close the test form' }));
        expect(onClose).toHaveBeenCalledWith({ dismissRunIds: ['r1'] });

        // What the shell does with it (useBuilderRuns.closeFormTest): r1 parking on page two stays closed.
        const dismissed = new Set<string>();
        recordDismissal(dismissed, { runId: 'r1', stepId: null, runIds: onClose.mock.calls[0][0]?.dismissRunIds });
        expect(shouldAutoOpenFormOverlay({ liveFromBuilder: true, runId: 'r1', awaitingStepId: 'fp_2', overlayOpen: false, dismissed })).toBe(false);
    });

    it('after the follow budget it says the run is still going and where to follow it, then checks again on request', async () => {
        const user = userEvent.setup();
        const server = serve(() => running);
        renderOverlay({ followTiming: { intervalMs: 5, maxPolls: 3 } });
        await user.type(screen.getByLabelText(/City/), 'Utrecht');
        await user.click(screen.getByRole('button', { name: 'Send' }));

        expect(await screen.findByText('Still running')).toBeTruthy();
        expect(screen.getByText(/Follow it on the canvas or in Runs/)).toBeTruthy();
        expect(screen.queryByText('Running the automation…')).toBeNull();
        const reads = server.calls.length;

        await user.click(screen.getByRole('button', { name: 'Check again' }));
        await waitFor(() => expect(server.calls.length).toBeGreaterThan(reads));
        expect(await screen.findByText('Still running')).toBeTruthy();
    });

    it('a read the server refuses (4xx) ends in "still running" at once', async () => {
        const user = userEvent.setup();
        const server = serve(() => ({ status: 403, body: { error: 'Forbidden' } }));
        renderOverlay({ followTiming: { intervalMs: 5, maxPolls: 1000 } });
        await user.type(screen.getByLabelText(/City/), 'Utrecht');
        await user.click(screen.getByRole('button', { name: 'Send' }));
        expect(await screen.findByText(/can no longer read the run/)).toBeTruthy();
        expect(server.calls.filter(c => c.path.endsWith('/form')).length).toBe(1);
    });
});

describe('FormRunOverlay — closing a page', () => {
    it('a click beside a typed page asks first; Go back keeps what was typed', async () => {
        const user = userEvent.setup();
        serve(() => running);
        const { onClose } = renderOverlay();
        await user.type(screen.getByLabelText(/City/), 'Utrecht');
        await user.click(screen.getByRole('dialog', { name: 'Test this form' }));

        expect(screen.getByRole('alertdialog', { name: 'Discard your answers?' })).toBeTruthy();
        expect(onClose).not.toHaveBeenCalled();
        await user.click(screen.getByRole('button', { name: 'Go back' }));
        expect(screen.queryByRole('alertdialog')).toBeNull();
        expect((screen.getByLabelText(/City/) as HTMLInputElement).value).toBe('Utrecht');

        await user.click(screen.getByRole('dialog', { name: 'Test this form' }));
        await user.click(screen.getByRole('button', { name: 'Discard' }));
        expect(onClose).toHaveBeenCalledWith({});
    });

    it('a click beside an untouched page, Esc, and the close button just close', async () => {
        const user = userEvent.setup();
        serve(() => running);
        const { onClose } = renderOverlay();
        await user.click(screen.getByRole('dialog', { name: 'Test this form' }));
        expect(onClose).toHaveBeenCalledTimes(1);

        cleanup();
        const second = renderOverlay();
        await user.type(screen.getByLabelText(/City/), 'Utrecht');
        await user.keyboard('{Escape}');
        expect(second.onClose).toHaveBeenCalledTimes(1);
    });

    it('a parked test run: "Keep it waiting" closes and leaves it parked', async () => {
        const user = userEvent.setup();
        const server = serve(() => ({ body: { runId: 'r1', status: 'awaiting_form', waiting: true, stepId: 'fp_2', form: PAGE_TWO } }));
        const { onClose } = renderOverlay();
        await user.type(screen.getByLabelText(/City/), 'Utrecht');
        await user.click(screen.getByRole('button', { name: 'Send' }));
        expect(await screen.findByText('Page two')).toBeTruthy();

        await user.click(screen.getByRole('button', { name: 'Close the test form' }));
        expect(screen.getByRole('alertdialog', { name: 'This test run is waiting' })).toBeTruthy();
        await user.click(screen.getByRole('button', { name: 'Keep it waiting' }));
        expect(onClose).toHaveBeenCalledWith({});
        expect(server.posts()).toEqual([]);
    });

    it('a parked test run: "Discard this test run" cancels it, then closes', async () => {
        const user = userEvent.setup();
        const server = serve(() => ({ body: { runId: 'r1', status: 'awaiting_form', waiting: true, stepId: 'fp_2', form: PAGE_TWO } }));
        const { onClose } = renderOverlay();
        await user.type(screen.getByLabelText(/City/), 'Utrecht');
        await user.click(screen.getByRole('button', { name: 'Send' }));
        expect(await screen.findByText('Page two')).toBeTruthy();

        await user.keyboard('{Escape}');
        await user.click(screen.getByRole('button', { name: 'Discard this test run' }));
        await waitFor(() => expect(onClose).toHaveBeenCalled());
        expect(server.posts().map(c => c.path)).toEqual(['/api/automation/runs/r1/cancel']);
    });

    it('a production run waiting on a page (Studio attach) closes without the test-run question', async () => {
        const user = userEvent.setup();
        serve(() => ({ body: { runId: 'r9', status: 'awaiting_form', waiting: true, stepId: 'fp_2', form: PAGE_TWO } }));
        const onClose = vi.fn();
        render(withQueryClient(<FormRunOverlay automationId="a1" runId="r9" runKind="production" onStartRun={vi.fn()} onClose={onClose} />));
        expect(await screen.findByText('Page two')).toBeTruthy();
        expect(screen.queryByTestId('form-run-chip')).toBeNull();
        await user.click(screen.getByRole('button', { name: 'Close the test form' }));
        expect(onClose).toHaveBeenCalledWith({});
    });
});
