/**
 * Studio > Runs answers a run that waits on a person (studio-and-forms F4):
 * "Answer this page" for a form page, "Decide" for an approval, both opening
 * the form test overlay ATTACHED to the run. Attach mode never starts a run;
 * every continuation and the close read the run again.
 *
 * The real run view against a fake server (test/formRunServer.ts); nothing is
 * mocked through the module system.
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { withQueryClient } from '@/test/queryWrapper';
import { fakeServer, type FakeCall } from '@/test/formRunServer';
import ExecutionView from './ExecutionView';

const PAGE_TWO = {
    title: 'Delivery', description: '', submitLabel: 'Continue', successMessage: 'Done', theme: {},
    fields: [{ name: 'address', type: 'text', label: 'Address', required: true, placeholder: '', help: '' }],
};
const APPROVAL = { approvalId: 'ap1', prompt: 'Ship it?', fields: [], canDecide: true, waitingOn: { stageName: null, seatCount: 1 }, isTest: true };

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function runView(status: string, extra: Record<string, unknown> = {}) {
    const run = { id: 'run9', automationId: 'a1', status, mode: 'dry_run', profile: { kind: 'dry' }, startedAt: '2026-11-03T10:00:00Z', ...extra };
    const state = { run, form: { runId: 'run9', status, waiting: status === 'awaiting_form', stepId: 'fp_2', form: PAGE_TWO, pendingApproval: status === 'awaiting_approval' ? APPROVAL : null } as Record<string, unknown> };
    const server = fakeServer((call: FakeCall) => {
        if (call.method === 'GET' && call.path === '/api/automation/runs/run9') return { body: { run: state.run } };
        if (call.method === 'GET' && call.path === '/api/automation/runs/run9/steps') return { body: { steps: [], definition: null } };
        if (call.method === 'GET' && call.path === '/api/automation/runs/run9/form') return { body: state.form };
        if (call.method === 'GET' && call.path === '/api/automation/runs/run10/form') return { body: { runId: 'run10', status: 'success', waiting: false, ending: null } };
        if (call.method === 'POST' && (call.path === '/api/automation/runs/run9/form' || call.path === '/api/automation/runs/run9/approve-step')) {
            state.run = { ...state.run, status: 'running' };
            return { status: 202, body: { accepted: true, pending: true, runId: 'run10' } };
        }
        return null;
    });
    render(withQueryClient(<ExecutionView runId="run9" run={run} scope="mine" onBack={vi.fn()} />));
    return server;
}

const runReads = (server: ReturnType<typeof fakeServer>) => server.calls.filter(c => c.method === 'GET' && c.path === '/api/automation/runs/run9').length;

describe('ExecutionView — answering a waiting run from Runs', () => {
    it('"Answer this page" attaches the overlay to the run, continues it, and never starts a new run', async () => {
        const user = userEvent.setup();
        const server = runView('awaiting_form');
        await user.click(await screen.findByRole('button', { name: 'Answer this page' }));

        expect(await screen.findByText('Delivery')).toBeTruthy();
        expect(screen.getByTestId('form-run-chip').textContent).toBe('Dry run');
        const readsBefore = runReads(server);
        await user.type(screen.getByLabelText(/Address/), 'Main street 1');
        await user.click(screen.getByRole('button', { name: 'Continue' }));

        expect(await screen.findByText('The automation finished.')).toBeTruthy();
        const posts = server.posts().map(c => c.path);
        expect(posts).toEqual(['/api/automation/runs/run9/form']);
        // The run view reads the run again on the continuation, so its status moves on.
        await waitFor(() => expect(runReads(server)).toBeGreaterThan(readsBefore));
        await waitFor(() => expect(screen.queryByRole('button', { name: 'Answer this page' })).toBeNull());

        await user.click(screen.getByRole('button', { name: 'See what each step did' }));
        expect(screen.queryByRole('dialog')).toBeNull();
    });

    it('"Decide" opens the approval in the overlay', async () => {
        const user = userEvent.setup();
        const server = runView('awaiting_approval');
        await user.click(await screen.findByRole('button', { name: 'Decide' }));
        const overlay = await screen.findByRole('dialog');
        expect(overlay.textContent).toContain('Ship it?');
        expect(overlay.textContent).toContain('Waiting for a decision');
        expect(server.posts()).toEqual([]);
    });

    it('a run that waits on nobody offers neither', async () => {
        const server = runView('running');
        await waitFor(() => expect(runReads(server)).toBeGreaterThan(0));
        expect(screen.queryByRole('button', { name: 'Answer this page' })).toBeNull();
        expect(screen.queryByRole('button', { name: 'Decide' })).toBeNull();
    });
});
