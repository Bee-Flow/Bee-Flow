/**
 * A journey that reaches an approval: form → approval → decide → next page →
 * done. The approval is a pause with its own phase, never an error (RUN-01,
 * pauses F2, run-watch F4, studio F1, tests-and-docs F3), and every
 * continuation is followed by its id, by the overlay and by the canvas
 * (pauses F8, run-watch F3).
 *
 * The server is faked at fetch (test/formRunServer.ts); no module is mocked.
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { withQueryClient } from '@/test/queryWrapper';
import { fakeServer, type FakeCall } from '@/test/formRunServer';
import FormRunOverlay from './FormRunOverlay';

const PAGE_ONE = {
    title: 'Order', description: '', submitLabel: 'Send', successMessage: 'Thanks', theme: {},
    fields: [{ name: 'item', type: 'text', label: 'Item', required: true, placeholder: '', help: '' }],
};
const PAGE_TWO = {
    title: 'Delivery', description: '', submitLabel: 'Continue', successMessage: 'Done', theme: {},
    fields: [{ name: 'address', type: 'text', label: 'Address', required: true, placeholder: '', help: '' }],
};
const APPROVAL = {
    approvalId: 'ap1',
    prompt: 'Approve the order for a chair?',
    detailsMd: null,
    fields: [{ name: 'po', type: 'text', label: 'PO number', required: true }],
    canDecide: true,
    waitingOn: { stageName: null, seatCount: 1 },
    isTest: true,
};
const TIMING = { intervalMs: 5, pausedMs: 20, maxPolls: 400 };

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

/** r1 waits on the approval, r2 (the continuation) on page two, r3 (after page two) is done. */
function journeyServer(approval: Record<string, unknown> = APPROVAL) {
    const formOf: Record<string, unknown> = {
        r1: { runId: 'r1', status: 'awaiting_approval', waiting: false, pendingApproval: approval },
        r2: { runId: 'r2', status: 'awaiting_form', waiting: true, stepId: 'fp_2', form: PAGE_TWO },
        r3: { runId: 'r3', status: 'success', waiting: false, ending: null },
    };
    return fakeServer((call: FakeCall) => {
        const read = call.method === 'GET' && /^\/api\/automation\/runs\/(r\d)\/form$/.exec(call.path);
        if (read) return { body: formOf[read[1]] };
        if (call.method === 'POST' && call.path === '/api/automation/runs/r1/approve-step') return { status: 202, body: { accepted: true, pending: true, runId: 'r2' } };
        if (call.method === 'POST' && call.path === '/api/automation/runs/r2/form') return { status: 202, body: { accepted: true, pending: true, runId: 'r3' } };
        if (call.method === 'POST' && call.path === '/api/automation/runs/r1/cancel') {
            formOf.r1 = { runId: 'r1', status: 'cancelled', waiting: false, ending: null };
            return { status: 202, body: { accepted: true } };
        }
        return null;
    });
}

function renderOverlay() {
    const onStartRun = vi.fn(async () => ({ kind: 'started' as const, runId: 'r1' }));
    const onFollowRun = vi.fn();
    const onClose = vi.fn();
    render(withQueryClient(
        <FormRunOverlay automationId="a1" form={PAGE_ONE} onStartRun={onStartRun} onFollowRun={onFollowRun} onClose={onClose} followTiming={TIMING} />,
    ));
    return { onStartRun, onFollowRun, onClose };
}

async function submitPageOne(user: ReturnType<typeof userEvent.setup>) {
    await user.type(screen.getByLabelText(/Item/), 'Chair');
    await user.click(screen.getByRole('button', { name: 'Send' }));
}

describe('FormRunOverlay — a journey through an approval', () => {
    it('form → approval → decide → next page → done, and never an error on the way', async () => {
        const user = userEvent.setup();
        const server = journeyServer();
        const { onFollowRun } = renderOverlay();
        await submitPageOne(user);

        // The pause reads as a pause: the run vocabulary's label, the snapshot's question, the sandbox seat.
        expect(await screen.findByText('Waiting for a decision')).toBeTruthy();
        expect(screen.getByText('Approve the order for a chair?')).toBeTruthy();
        expect(screen.getByText(/Test decision: you decide for every approver/)).toBeTruthy();
        expect(screen.queryByText('Failed')).toBeNull();
        expect(screen.queryByText(/awaiting_approval/)).toBeNull();

        await user.type(screen.getByLabelText(/PO number/), '4471');
        await user.click(screen.getByRole('button', { name: /Approve/ }));

        // The decision continues the journey, answered at once with the continuation's id.
        await waitFor(() => expect(server.posts().some(c => c.path === '/api/automation/runs/r1/approve-step')).toBe(true));
        const decided = server.posts().find(c => c.path === '/api/automation/runs/r1/approve-step');
        expect(decided?.body).toEqual({ decision: 'approve', answers: { po: '4471' }, respond: 'created' });
        expect(onFollowRun).toHaveBeenCalledWith('r2');

        // The continuation parks on page two, which is answered here too.
        expect(await screen.findByText('Delivery')).toBeTruthy();
        await user.type(screen.getByLabelText(/Address/), 'Main street 1');
        await user.click(screen.getByRole('button', { name: 'Continue' }));
        await waitFor(() => expect(onFollowRun).toHaveBeenCalledWith('r3'));
        const answered = server.posts().find(c => c.path === '/api/automation/runs/r2/form');
        expect(answered?.body).toEqual({ stepId: 'fp_2', values: { address: 'Main street 1' }, respond: 'created' });

        expect(await screen.findByText('The automation finished.')).toBeTruthy();
        expect(screen.getByRole('button', { name: 'Save these answers as a scenario' })).toBeTruthy();
        expect(screen.queryByText('Failed')).toBeNull();
    });

    it('waiting on somebody else: says who, and Withdraw ends the run', async () => {
        const user = userEvent.setup();
        const server = journeyServer({ ...APPROVAL, canDecide: false, isTest: false, waitingOn: { stageName: 'Finance', seatCount: 2 } });
        renderOverlay();
        await submitPageOne(user);

        expect(await screen.findByText('Waiting for Finance (2)')).toBeTruthy();
        expect(screen.queryByRole('button', { name: /Approve/ })).toBeNull();
        await user.click(screen.getByRole('button', { name: 'Withdraw' }));

        await waitFor(() => expect(server.posts().some(c => c.path === '/api/automation/runs/r1/cancel')).toBe(true));
        expect(await screen.findByText('Stopped')).toBeTruthy();
    });

    it('a decision the server refuses stays on the approval and says why', async () => {
        const user = userEvent.setup();
        fakeServer((call) => {
            if (call.method === 'GET' && call.path === '/api/automation/runs/r1/form') return { body: { runId: 'r1', status: 'awaiting_approval', waiting: false, pendingApproval: { ...APPROVAL, fields: [] } } };
            if (call.method === 'POST' && call.path === '/api/automation/runs/r1/approve-step') return { status: 409, body: { error: 'Run is in success state, not awaiting_approval' } };
            return null;
        });
        renderOverlay();
        await submitPageOne(user);
        await user.click(await screen.findByRole('button', { name: /Approve/ }));
        expect((await screen.findByRole('alert')).textContent).toContain('not awaiting_approval');
        expect(screen.getByText('Waiting for a decision')).toBeTruthy();
    });
});
