// One card for everything that waits for the owner (./CoworkNeedCard.tsx): per kind one sentence, a primary action
// that calls the right API, and a way out. The network is the seam (a recording fetch); no module is mocked.
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithClient } from '@/test/render';
import { jsonResponse, stubRecordingFetch, type RecordedCall } from '@/test/recordingFetch';
import CoworkNeedCard from './CoworkNeedCard';
import type { NeedCardData } from './coworkNeedsModel';

const PROPOSAL = {
    id: 'pr-1', kind: 'repair', reasonCode: 'step_failed_twice', stepId: 'orders', stepTitle: 'Read the order table', status: 'open', fingerprint: 'f'.repeat(64),
    createdAt: null, decidedAt: null, changes: [{ id: 'orders', title: 'Read the order table', kind: 'fixed', change: 'changed' }], widens: [], replay: null, undoVersion: null,
};
const TRUST = { entries: [{ stepId: 'mail', title: 'Mail it', recipient: 'finance@northwind.example', letThrough: 3, trusted: false, canTrust: true }], needed: 3, ceilingAllows: true };

let calls: RecordedCall[];
function serve() {
    calls = stubRecordingFetch(({ url }) => {
        if (url.includes('/api/automation/approvals?')) return jsonResponse({ approvals: [{ id: 'ap-1', prompt: 'Send the overdue list to finance@northwind.example?', detailsMd: '3 invoices are overdue.' }] });
        if (url.endsWith('/proposals')) return jsonResponse({ proposals: [PROPOSAL] });
        if (url.endsWith('/plan/trust')) return jsonResponse(TRUST);
        return jsonResponse({});
    });
}
afterEach(() => { vi.unstubAllGlobals(); });

const card = (over: Partial<NeedCardData>): NeedCardData => ({ key: 'k', kind: 'check', itemId: 'w1', title: 'Weekly digest', ...over });
const posted = (path: string, method = 'POST') => calls.find((c) => c.method === method && new URL(c.url, 'http://x').pathname === path);

async function press(need: NeedCardData, name: string, props: { solo?: boolean } = {}) {
    serve();
    const onOpenTask = vi.fn();
    const onDone = vi.fn();
    renderWithClient(<CoworkNeedCard need={need} onOpenTask={onOpenTask} onDone={onDone} {...props} />);
    await userEvent.setup().click(await screen.findByRole('button', { name }));
    return { onOpenTask, onDone };
}

describe('CoworkNeedCard — the primary action of each kind', () => {
    it('check, on the home: opens the task at its steps', async () => {
        const { onOpenTask } = await press(card({ kind: 'check' }), 'Check the steps');
        expect(onOpenTask).toHaveBeenCalledWith('w1', 'steps');
        expect(screen.getByText('The steps are ready and tested. Check them once.')).toBeInTheDocument();
    });

    it('check, inside the task: approves the steps on screen', async () => {
        await press(card({ kind: 'check', fingerprint: 'abc' }), 'Approve the steps', { solo: true });
        await waitFor(() => expect(posted('/api/cowork/w1/plan/approve')?.body).toEqual({ fingerprint: 'abc' }));
        expect(screen.queryByRole('button', { name: /Weekly digest/ })).toBeNull();
    });

    it('first test: tries the steps once; Remove deletes the task', async () => {
        await press(card({ kind: 'first_test' }), 'Test it now');
        await waitFor(() => expect(posted('/api/cowork/w1/plan/try')).toBeTruthy());
        await userEvent.setup().click(screen.getByRole('button', { name: 'Remove' }));
        await waitFor(() => expect(posted('/api/cowork/w1', 'DELETE')).toBeTruthy());
    });

    it('fix of the wiring: Cowork fixes the order of the steps (POST /plan/fix-wiring)', async () => {
        const { onDone } = await press(card({ kind: 'fix', problem: 'wiring' }), 'Fix it for me');
        await waitFor(() => expect(posted('/api/cowork/w1/plan/fix-wiring')).toBeTruthy());
        await waitFor(() => expect(onDone).toHaveBeenCalled());
        expect(screen.getByText('The steps are in the wrong order, so it cannot run.')).toBeInTheDocument();
    });

    it('fix of a run that did not do its work: runs it again; the way out lets the AI do it each time for a plan', async () => {
        await press(card({ kind: 'fix', problem: 'incomplete' }), 'Run it again');
        await waitFor(() => expect(posted('/api/cowork/w1/run-now')).toBeTruthy());
        vi.unstubAllGlobals();
        await press(card({ kind: 'fix', problem: 'tried_failed', key: 'k2' }), 'Let the AI do it each time');
        await waitFor(() => expect(posted('/api/cowork/w1/plan', 'DELETE')).toBeTruthy());
    });

    it('repair: approves the fix with the fingerprint of the proposal looked at; Not now puts it aside', async () => {
        const need = card({ kind: 'repair', repair: { proposalId: 'pr-1', reasonCode: 'step_failed_twice', stepTitle: 'Read the order table' } });
        serve();
        renderWithClient(<CoworkNeedCard need={need} />);
        expect(screen.getByText("Failed twice at 'Read the order table'. A fix is ready.")).toBeInTheDocument();
        const user = userEvent.setup();
        await user.click(await screen.findByRole('button', { name: 'See what changes' }));
        expect(screen.getByTestId('cowork-proposal-details')).toBeInTheDocument();
        await user.click(screen.getByRole('button', { name: 'Approve the fix' }));
        await waitFor(() => expect(posted('/api/cowork/w1/proposals/pr-1/approve')?.body).toEqual({ fingerprint: PROPOSAL.fingerprint }));
        await user.click(screen.getByRole('button', { name: 'Not now' }));
        await waitFor(() => expect(posted('/api/cowork/w1/proposals/pr-1/dismiss')).toBeTruthy());
    });

    it('sign-in: the primary goes to the connections; the way out turns the task back on', async () => {
        serve();
        renderWithClient(<CoworkNeedCard need={card({ kind: 'sign_in' })} />);
        expect(screen.getByRole('link', { name: 'Sign in again' })).toHaveAttribute('href', expect.stringContaining('/app/settings/'));
        await userEvent.setup().click(screen.getByRole('button', { name: 'Turn it back on' }));
        await waitFor(() => expect(posted('/api/cowork/w1/toggle')).toBeTruthy());
    });

    it('send: shows the message, approves it, then asks "always allow this recipient?" and trusts it', async () => {
        const need = card({ kind: 'send', runId: 'r1', automationId: 'auto-1' });
        serve();
        const onDone = vi.fn();
        renderWithClient(<CoworkNeedCard need={need} onDone={onDone} />);
        expect(await screen.findByTestId('cowork-need-message')).toHaveTextContent('3 invoices are overdue.');
        expect(calls[0].url).toContain('automationId=auto-1');
        const user = userEvent.setup();
        await user.click(screen.getByRole('button', { name: 'Send' }));
        await waitFor(() => expect(posted('/api/automation/approvals/ap-1/decide')?.body).toEqual({ decision: 'approve' }));
        expect(await screen.findByText('Always allow this task to send to finance@northwind.example from now on?')).toBeInTheDocument();
        await user.click(screen.getByRole('button', { name: 'Always allow' }));
        await waitFor(() => expect(posted('/api/cowork/w1/plan/trust', 'PUT')?.body).toEqual({ stepId: 'mail', recipient: 'finance@northwind.example', trusted: true }));
        await waitFor(() => expect(onDone).toHaveBeenCalledWith('From now on it sends to finance@northwind.example without asking.'));
    });

    it('send: Don\'t send rejects the approval', async () => {
        await press(card({ kind: 'send', automationId: 'auto-1' }), 'Don’t send');
        await waitFor(() => expect(posted('/api/automation/approvals/ap-1/decide')?.body).toEqual({ decision: 'reject' }));
    });

    it('review: Approve answers so it goes on; asking for changes sends the note', async () => {
        await press(card({ kind: 'review', runId: 'r2', reason: 'Is this discount right?' }), 'Approve');
        await waitFor(() => expect(posted('/api/cowork/w1/runs/r2/review')?.body).toEqual({ action: 'answer', answer: 'Approved. Go ahead.' }));
        vi.unstubAllGlobals();
        serve();
        renderWithClient(<CoworkNeedCard need={card({ kind: 'review', runId: 'r3', key: 'k3' })} />);
        const user = userEvent.setup();
        await user.click(screen.getAllByRole('button', { name: 'Ask for changes' }).at(-1) as HTMLElement);
        await user.type(screen.getByLabelText('What should change?'), 'Shorter');
        await user.click(screen.getByRole('button', { name: 'Send note and redo' }));
        await waitFor(() => expect(posted('/api/cowork/w1/runs/r3/review')?.body).toEqual({ action: 'answer', answer: 'Shorter' }));
    });

    it('hand-off: allows the colleague\'s task to get the result; Not now hides the card', async () => {
        const need = card({ kind: 'hand_off', handOff: { deskId: 'd1', followerId: 'c1', followerTitle: 'Stock check', ownerName: 'Noor Haddad' } });
        await press(need, 'Allow');
        await waitFor(() => expect(posted('/api/cowork/desks/d1/members/c1/hand-off')).toBeTruthy());
        expect(screen.getByText('Noor Haddad’s task “Stock check” asks for the result of this task')).toBeInTheDocument();
    });

    it('invitation: accepts the desk for this task; Decline takes it off', async () => {
        const need = card({ kind: 'invitation', desk: { id: 'd1', name: 'Supplier desk', invitedBy: 'Sam Peters' } });
        await press(need, 'Accept');
        await waitFor(() => expect(posted('/api/cowork/desks/d1/members/w1/accept')).toBeTruthy());
        await userEvent.setup().click(screen.getByRole('button', { name: 'Decline' }));
        await waitFor(() => expect(posted('/api/cowork/desks/d1/members/w1', 'DELETE')).toBeTruthy());
    });

    it('a refusal is said in the server\'s words under the buttons', async () => {
        calls = stubRecordingFetch(() => jsonResponse({ error: 'This plan cannot be approved yet.', code: 'cowork_plan_untried' }, 422));
        renderWithClient(<CoworkNeedCard need={card({ kind: 'first_test' })} />);
        await userEvent.setup().click(screen.getByRole('button', { name: 'Test it now' }));
        expect(await screen.findByRole('alert')).toHaveTextContent('This plan cannot be approved yet.');
    });
});
