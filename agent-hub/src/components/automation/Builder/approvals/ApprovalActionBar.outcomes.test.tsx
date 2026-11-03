import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ApprovalActionBar from './ApprovalActionBar';
import { installRunTransport, json, type RunRoute } from '@/test/runTransport';

/**
 * The builder's approval bar reads what the decision did (tests-and-docs F5,
 * studio F6) and hands the run back to the canvas (RUN-02, run-watch F2,
 * pauses F4): a vote is a vote, a passed stage names the next one, an approve
 * is followed, a reject says whether the run stopped or went on along its
 * rejected branch. Every decision calls onFollowRun, so the bar goes away by
 * itself and nobody clicks twice into a 409.
 *
 * The server is the transport seam of authFetch (test/runTransport), the
 * toasts are read off their window event; nothing is module-mocked.
 */
let server: ReturnType<typeof installRunTransport> | null = null;
let toasts: Array<{ kind: string; message: string }> = [];
const onToast = (e: Event) => {
    const item = (e as CustomEvent<{ item: { kind: string; message: string } }>).detail.item;
    toasts.push({ kind: item.kind, message: item.message });
};

function serve(route: RunRoute) { server = installRunTransport(route); return server; }
const decideWith = (body: unknown, status = 200): RunRoute => (url) => (url.endsWith('/runs/r1/approve-step') ? json(body, status) : null);
const lastToast = () => toasts[toasts.length - 1];

beforeEach(() => { cleanup(); toasts = []; window.addEventListener('beeflow:toast', onToast); });
afterEach(() => { window.removeEventListener('beeflow:toast', onToast); server?.uninstall(); server = null; });

async function approve() { await userEvent.click(screen.getByRole('button', { name: 'Approve' })); }
async function reject() {
    await userEvent.type(screen.getByLabelText('Reason for your decision'), 'Not this week');
    await userEvent.click(screen.getByRole('button', { name: 'Reject' }));
}

describe('ApprovalActionBar — what the decision did', () => {
    it('a vote: the approval still waits, and the canvas reads the run again', async () => {
        serve(decideWith({ accepted: true, decision: 'vote_recorded', progress: { rule: 'all' } }));
        const onFollowRun = vi.fn();
        render(<ApprovalActionBar runId="r1" onFollowRun={onFollowRun} />);
        await approve();
        await waitFor(() => expect(onFollowRun).toHaveBeenCalledWith('r1'));
        expect(lastToast()).toEqual({ kind: 'success', message: 'Your vote is in — waiting for the other approvers.' });
    });

    it('a stage that passed names the next stage', async () => {
        serve(decideWith({
            accepted: true, decision: 'vote_recorded', stage: 's2',
            progress: { kind: 'stages', position: { index: 2, total: 2 }, stages: [{ key: 's1', name: 'Team' }, { key: 's2', name: 'Finance' }] },
        }));
        render(<ApprovalActionBar runId="r1" onFollowRun={vi.fn()} />);
        await approve();
        await waitFor(() => expect(lastToast()?.message).toBe('This stage is done — it has moved on to Finance (stage 2 of 2).'));
    });

    it('an approve still running (202): followed, asked for as soon as the continuation exists', async () => {
        const s = serve(decideWith({ accepted: true, pending: true, runId: 'child-1', message: 'Resume started' }, 202));
        const onFollowRun = vi.fn();
        const onResolved = vi.fn();
        render(<ApprovalActionBar runId="r1" onFollowRun={onFollowRun} onResolved={onResolved} />);
        await approve();
        await waitFor(() => expect(onFollowRun).toHaveBeenCalledWith('r1'));
        expect(onResolved).toHaveBeenCalledWith('approve');
        expect(lastToast()?.message).toBe('Approved — following the run.');
        expect(s.calls[0].body).toMatchObject({ decision: 'approve', respond: 'created' });
    });

    it('a surface that does not follow the run (Studio\'s run view) waits for the answer and says "continuing"', async () => {
        const s = serve(decideWith({ accepted: true, decision: 'approve', run: { id: 'child-1', status: 'success' } }));
        render(<ApprovalActionBar runId="r1" />);
        await approve();
        await waitFor(() => expect(lastToast()?.message).toBe('Approved — the run is continuing.'));
        expect((s.calls[0].body as { respond?: string }).respond).toBeUndefined();
    });

    it('a reject that ended the run', async () => {
        serve(decideWith({ accepted: true, decision: 'reject', run: { id: 'r1', status: 'error', errorClass: 'ApprovalRejected' } }));
        const onFollowRun = vi.fn();
        render(<ApprovalActionBar runId="r1" onFollowRun={onFollowRun} />);
        await reject();
        await waitFor(() => expect(lastToast()?.message).toBe('Rejected — the run has stopped.'));
        expect(onFollowRun).toHaveBeenCalledWith('r1');
    });

    it('a reject that continued on the rejected branch', async () => {
        serve(decideWith({ accepted: true, pending: true, runId: 'child-2', decision: 'reject' }, 202));
        render(<ApprovalActionBar runId="r1" onFollowRun={vi.fn()} />);
        await reject();
        await waitFor(() => expect(lastToast()?.message).toBe('Rejected — following the run on the rejected branch.'));
    });

    it('a decision the run moved past (409): says so, and the canvas catches up', async () => {
        serve(decideWith({ error: 'Run is in success state, not awaiting_approval' }, 409));
        const onFollowRun = vi.fn();
        render(<ApprovalActionBar runId="r1" onFollowRun={onFollowRun} />);
        await approve();
        await waitFor(() => expect(lastToast()).toEqual({ kind: 'error', message: 'This approval was already decided.' }));
        expect(onFollowRun).toHaveBeenCalledWith('r1');
    });
});

describe('ApprovalActionBar — whose decision it is', () => {
    it('a test approval: the tester decides for every approver', () => {
        render(<ApprovalActionBar runId="r1" isTest />);
        expect(screen.getByTestId('approval-action-bar-title').textContent).toBe('Waiting for your decision (test)');
        expect(screen.getByText('Test decision: you decide for every approver.')).toBeTruthy();
    });

    it('somebody else\'s stage: who it waits on, no Approve, and a Withdraw that closes the run', async () => {
        const s = serve((url) => (url.endsWith('/runs/r1/cancel') ? json({ accepted: true, run: { id: 'r1', status: 'cancelled' } }, 202) : null));
        const onFollowRun = vi.fn();
        render(<ApprovalActionBar runId="r1" canDecide={false} waitingOn={{ stageName: 'Finance', seatCount: 2 }} onFollowRun={onFollowRun} />);
        expect(screen.getByTestId('approval-action-bar-title').textContent).toBe('Waiting for Finance (2)');
        expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
        await userEvent.click(screen.getByTestId('approval-action-bar-withdraw'));
        await userEvent.click(await screen.findByTestId('confirm-dialog-confirm'));
        await waitFor(() => expect(onFollowRun).toHaveBeenCalledWith('r1'));
        expect(s.calls.map(c => `${c.method} ${c.url.replace(/^.*\/api\/automation/, '')}`)).toEqual(['POST /runs/r1/cancel']);
        expect(lastToast()?.message).toBe('Request withdrawn.');
    });
});
