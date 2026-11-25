// One card for everything that waits for the owner (./CoworkNeedCard.tsx): per kind one sentence, a primary action
// that calls the right API, and a way out. The network is the seam (a recording fetch); no module is mocked.
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithClient } from '@/test/render';
import { jsonResponse, stubRecordingFetch, type RecordedCall } from '@/test/recordingFetch';
import CoworkNeedCard from './CoworkNeedCard';
import { softClasses } from './crisp.testkit';
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
    it('check, on the home: "Open and approve" opens the task at its steps', async () => {
        const { onOpenTask } = await press(card({ kind: 'check', held: true }), 'Open and approve');
        expect(onOpenTask).toHaveBeenCalledWith('w1', 'steps');
        expect(screen.getByText('The steps are ready and tested. Check them once.')).toBeInTheDocument();
        expect(screen.getByText('It does not run for real until you approve them.')).toBeInTheDocument();
    });

    it('check, inside the task: "Approve" approves the steps on screen, "Test, sends nothing" tries them once more', async () => {
        await press(card({ kind: 'check', fingerprint: 'abc' }), 'Approve', { solo: true });
        await waitFor(() => expect(posted('/api/cowork/w1/plan/approve')?.body).toEqual({ fingerprint: 'abc' }));
        expect(screen.queryByRole('button', { name: /Weekly digest/ })).toBeNull();
        await userEvent.setup().click(screen.getByRole('button', { name: 'Test, sends nothing' }));
        await waitFor(() => expect(posted('/api/cowork/w1/plan/try')).toBeTruthy());
    });

    it('first test: tests the steps once; Remove asks first, and only then deletes the task', async () => {
        await press(card({ kind: 'first_test' }), 'Test, sends nothing');
        await waitFor(() => expect(posted('/api/cowork/w1/plan/try')).toBeTruthy());
        const user = userEvent.setup();
        await user.click(screen.getByRole('button', { name: 'Remove' }));
        expect(screen.getByText('Remove this task? This cannot be undone.')).toBeInTheDocument();
        expect(posted('/api/cowork/w1', 'DELETE')).toBeUndefined();
        await user.click(screen.getByRole('button', { name: 'Keep it' }));
        await user.click(screen.getByRole('button', { name: 'Remove' }));
        await user.click(screen.getByRole('button', { name: 'Remove the task' }));
        await waitFor(() => expect(posted('/api/cowork/w1', 'DELETE')).toBeTruthy());
    });

    it('fix of the wiring: Cowork fixes the order of the steps (POST /plan/fix-wiring)', async () => {
        const { onDone } = await press(card({ kind: 'fix', problem: 'wiring' }), 'Fix it for me');
        await waitFor(() => expect(posted('/api/cowork/w1/plan/fix-wiring')).toBeTruthy());
        await waitFor(() => expect(onDone).toHaveBeenCalled());
        expect(screen.getByText('The steps are in the wrong order, so it cannot run.')).toBeInTheDocument();
    });

    it('a run that did not do its work: "See what is wrong" opens the task at its steps; the way out runs it again', async () => {
        const { onOpenTask } = await press(card({ kind: 'fix', problem: 'incomplete', words: { step: 'Get each meeting summary', source: null, app: null } }), 'See what is wrong');
        expect(onOpenTask).toHaveBeenCalledWith('w1', 'steps');
        expect(screen.getByText('‘Get each meeting summary’ found nothing to work on in the last run.')).toBeInTheDocument();
        await userEvent.setup().click(screen.getByRole('button', { name: 'Run it again' }));
        await waitFor(() => expect(posted('/api/cowork/w1/run-now')).toBeTruthy());
    });

    it('an app that is no longer allowed: names the app, says where to allow it, and offers one primary action', async () => {
        const need = card({ kind: 'fix', problem: 'permission', hasSteps: true, words: { step: 'List last week’s meetings', source: null, app: 'Fireflies' } });
        const { onOpenTask } = await press(need, 'See what is wrong');
        expect(onOpenTask).toHaveBeenCalledWith('w1', undefined);
        expect(screen.getByText('Fireflies is no longer allowed for this task.')).toBeInTheDocument();
        expect(screen.getByText('Allow it again under Uses, or let the AI work it out every run.')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Let the AI work it out every run' })).toBeInTheDocument();
        const text = screen.getByTestId('cowork-need-card').textContent ?? '';
        for (const raw of ['automation', 'fireflies_', 'permission to use']) expect(text).not.toContain(raw);
    });

    it('a step that could not read from another names both; a sign-in that ran out leads to signing in', async () => {
        serve();
        renderWithClient(<CoworkNeedCard need={card({ kind: 'fix', problem: 'reads', words: { step: 'Write the summary', source: 'Get each meeting summary', app: null } })} />);
        expect(screen.getByText('‘Write the summary’ could not read what it needs from ‘Get each meeting summary’.')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Run it again' })).toBeInTheDocument();
        renderWithClient(<CoworkNeedCard need={card({ kind: 'fix', problem: 'signed_out', key: 'k2', words: { step: null, source: null, app: 'Gmail' } })} />);
        expect(screen.getByText('The sign-in of Gmail ran out.')).toBeInTheDocument();
        expect(screen.getByRole('link', { name: 'Sign in again' })).toHaveAttribute('href', expect.stringContaining('/app/settings/'));
    });

    it('a run that just failed says so without the error', async () => {
        const { onOpenTask } = await press(card({ kind: 'fix', problem: 'failed' }), 'See what is wrong');
        expect(onOpenTask).toHaveBeenCalledWith('w1', undefined);
        expect(screen.getByText('The last run failed.')).toBeInTheDocument();
    });

    it('a run that took too long is run again', async () => {
        await press(card({ kind: 'fix', problem: 'timeout' }), 'Run it again');
        await waitFor(() => expect(posted('/api/cowork/w1/run-now')).toBeTruthy());
        expect(screen.getByText('The last run took too long and was stopped.')).toBeInTheDocument();
    });

    it('"Let the AI work it out every run" says what happened and can be undone: Undo puts the card back', async () => {
        const { onDone } = await press(card({ kind: 'fix', problem: 'tried_failed', hasSteps: true }), 'Let the AI work it out every run');
        await waitFor(() => expect(posted('/api/cowork/w1/setup', 'PUT')?.body).toEqual({ mode: 'ai' }));
        expect(await screen.findByText('The AI works this task out on every run from now on.')).toBeInTheDocument();
        expect(onDone).not.toHaveBeenCalled();
        await userEvent.setup().click(screen.getByRole('button', { name: 'Undo' }));
        await waitFor(() => expect(calls.filter((c) => c.method === 'PUT' && c.url.endsWith('/api/cowork/w1/setup')).map((c) => c.body)).toEqual([{ mode: 'ai' }, { mode: 'steps' }]));
        expect(await screen.findByText('The test of the steps did not pass.')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Let the AI work it out every run' })).toBeInTheDocument();
    });

    it('a set-up that did not work: says why and that the task waits; "Try setting up again" makes the steps once more', async () => {
        const made = 'event: done\ndata: {"summary":"ok","state":{"automationId":"auto-1"}}\n\n';
        calls = stubRecordingFetch(({ url }) => (url.endsWith('/plan/make') ? new Response(made, { status: 200, headers: { 'content-type': 'text/event-stream' } }) : jsonResponse({})));
        const onDone = vi.fn();
        renderWithClient(<CoworkNeedCard need={card({ kind: 'setup', cause: 'left' })} onDone={onDone} />);
        expect(screen.getByText('Cowork could not set up the steps.')).toBeInTheDocument();
        expect(screen.getByText('It was not finished: the page was closed while Cowork was setting up. Until you choose, this task does not run.')).toBeInTheDocument();
        await userEvent.setup().click(screen.getByRole('button', { name: 'Try setting up again' }));
        await waitFor(() => expect(posted('/api/cowork/w1/plan/make')).toBeTruthy());
        await waitFor(() => expect(onDone).toHaveBeenCalledWith('The steps are ready and tested. Open and approve them under Needs you.'));
    });

    it('a set-up that fails again keeps the task waiting and says so; choosing the AI there can be undone too', async () => {
        calls = stubRecordingFetch(({ url }) => (url.endsWith('/plan/make') ? jsonResponse({ error: 'No AI model is configured for this workspace, so a plan cannot be made yet.' }, 409) : jsonResponse({})));
        renderWithClient(<CoworkNeedCard need={card({ kind: 'setup', cause: 'no_model' })} />);
        const user = userEvent.setup();
        await user.click(screen.getByRole('button', { name: 'Try setting up again' }));
        expect(await screen.findByRole('alert')).toHaveTextContent('That did not work this time either. The task keeps waiting for you.');
        await user.click(screen.getByRole('button', { name: 'Let the AI work it out every run' }));
        await waitFor(() => expect(posted('/api/cowork/w1/setup', 'PUT')?.body).toEqual({ mode: 'ai' }));
        await user.click(await screen.findByRole('button', { name: 'Undo' }));
        expect(await screen.findByText('Cowork could not set up the steps.')).toBeInTheDocument();
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

    it('sign-in: a task that signing in already resumed is left on, not paused by the flip', async () => {
        calls = stubRecordingFetch(({ url }) => jsonResponse(url.endsWith('/api/cowork/w1') ? { id: 'w1', isActive: true } : {}));
        const onDone = vi.fn();
        renderWithClient(<CoworkNeedCard need={card({ kind: 'sign_in' })} onDone={onDone} />);
        await userEvent.setup().click(screen.getByRole('button', { name: 'Turn it back on' }));
        await waitFor(() => expect(onDone).toHaveBeenCalledWith('It is on again.'));
        expect(posted('/api/cowork/w1/toggle')).toBeUndefined();
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

    it('every kind of card is crisp at rest, on the home and inside the task', () => {
        serve();
        const needs = [
            card({ kind: 'check', held: true }), card({ kind: 'first_test', key: 'k1' }), card({ kind: 'setup', cause: 'timeout', key: 'k2' }), card({ kind: 'sign_in', key: 'k3' }),
            card({ kind: 'fix', problem: 'permission', hasSteps: true, key: 'k4', words: { step: 'List meetings', source: null, app: 'Fireflies' } }),
            card({ kind: 'review', runId: 'r1', reason: 'Is this right?', key: 'k5' }),
        ];
        const { container } = renderWithClient(<>{needs.map((need, i) => <CoworkNeedCard key={need.key} need={need} solo={i % 2 === 1} />)}</>);
        expect(screen.getAllByTestId('cowork-need-card')).toHaveLength(needs.length);
        expect(softClasses(container)).toEqual([]);
    });

    it('a refusal is said in the server\'s words under the buttons', async () => {
        calls = stubRecordingFetch(() => jsonResponse({ error: 'This plan cannot be approved yet.', code: 'cowork_plan_untried' }, 422));
        renderWithClient(<CoworkNeedCard need={card({ kind: 'first_test' })} />);
        await userEvent.setup().click(screen.getByRole('button', { name: 'Test, sends nothing' }));
        expect(await screen.findByRole('alert')).toHaveTextContent('This plan cannot be approved yet.');
    });
});
