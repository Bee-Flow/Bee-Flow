// The opened task (./CoworkTaskView.tsx) against a recording fetch (./taskWorld.testkit.tsx), no module mocked: its
// steps in run order with the in-between steps folded and the recipient named, "Run for real now" held back with the
// reason said, what the test produced before the first approval, Share and Give away under People, Restore, Delete
// and raw errors under History, and someone else's task read only.
import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { softClasses } from '../crisp.testkit';
import { NEEDS_APPROVAL, PLAN_WAITING, RUN, openTask } from './taskWorld.testkit';

const AUTO_FIX = {
    id: 'pr-auto', kind: 'repair', reasonCode: 'reference_fixed', stepId: 'read', stepTitle: 'Read the mail', status: 'approved', fingerprint: 'f'.repeat(64),
    createdAt: null, decidedAt: '2026-11-24T08:00:00.000Z', changes: [], widens: [], replay: null, undoVersion: 1,
};
const FAILED_RUN = { id: 'r0', status: 'error', startedAt: '2026-11-22T08:00:00.000Z', error: 'datetime: input "{{steps.dtac3ed7.output.iso}}" did not resolve to a parseable date' };

afterEach(() => { vi.unstubAllGlobals(); });

describe('the task page is crisp', () => {
    it('nothing that holds text carries a transform, a filter or a backdrop filter at rest: closed, and with every row opened', async () => {
        const { user } = openTask({ plan: PLAN_WAITING, needs: [NEEDS_APPROVAL], runs: [FAILED_RUN, RUN], colleagues: [{ id: 'u2', name: 'Bo Jansen' }] });
        const page = await screen.findByTestId('cowork-task-view');
        await screen.findByTestId('cowork-task-would-receive');
        await waitFor(() => expect(within(page).getAllByTestId('cowork-task-run')).toHaveLength(2));
        expect(softClasses(page)).toEqual([]);
        // Every row that opens in place, one after another: the four of Settings, People's, History's, and a run.
        const rows = ['cowork-task-setting-what', 'cowork-task-setting-when', 'cowork-task-setting-uses', 'cowork-task-setting-sends',
            'cowork-task-row-share', 'cowork-task-row-pass', 'cowork-task-row-template', 'cowork-task-row-give', 'cowork-task-row-changes', 'cowork-task-row-proof'];
        for (const id of rows) {
            const head = within(within(page).getByTestId(id)).getAllByRole('button')[0];
            await user.click(head);
            expect(head).toHaveAttribute('aria-expanded', 'true');
            expect(softClasses(page), id).toEqual([]);
        }
        await user.click(within(within(page).getAllByTestId('cowork-task-run')[0]).getByRole('button'));
        await user.click(within(page).getByRole('button', { name: 'Technical details' }));
        await user.click(within(page).getByRole('button', { name: 'Delete this task' }));
        expect(softClasses(page)).toEqual([]);
    });
});

describe('CoworkTaskView', () => {
    it('lists the steps in run order, the in-between step folded until asked for, and names who the sending step reaches', async () => {
        const { user } = openTask();
        const steps = await screen.findByTestId('cowork-task-steps');
        await waitFor(() => expect(within(steps).getAllByTestId('cowork-task-step')).toHaveLength(3));
        expect(within(steps).getAllByTestId('cowork-task-step').map((li) => li.textContent)).toEqual([
            expect.stringContaining('Read the mail'), expect.stringContaining('Write the digest'), expect.stringContaining('Tell me'),
        ]);
        expect(within(steps).getAllByTestId('cowork-task-step-word').at(-1)).toHaveTextContent('Sends to you');
        await user.click(within(steps).getByRole('button', { name: 'Show 1 in-between step' }));
        expect(within(steps).getAllByTestId('cowork-task-step').map((li) => li.textContent)).toEqual([
            expect.stringContaining('Read the mail'), expect.stringContaining('Keep this weekIn-between step'), expect.stringContaining('Write the digest'), expect.stringContaining('Tell me'),
        ]);
        expect(within(steps).getByRole('button', { name: 'Test, sends nothing' })).toBeEnabled();
        expect(within(steps).getByRole('button', { name: 'Compare with last month' })).toBeEnabled();
    });

    it('keeps "Run for real now" off while its steps wait for approval, and says why on the button and under it', async () => {
        openTask({ plan: PLAN_WAITING, needs: [NEEDS_APPROVAL] });
        await screen.findByTestId('cowork-task-would-receive');
        const run = screen.getByRole('button', { name: 'Run for real now' });
        expect(run).toBeDisabled();
        expect(run).toHaveAttribute('title', 'It cannot run for real yet: its steps wait for your approval.');
        expect(screen.getByTestId('cowork-task-held')).toHaveTextContent('It cannot run for real yet: its steps wait for your approval.');
        expect(run).toHaveAccessibleDescription('It cannot run for real yet: its steps wait for your approval.');
    });

    it('runs for real when nothing waits, and says nothing is held back', async () => {
        const { user, sent } = openTask();
        const run = await screen.findByRole('button', { name: 'Run for real now' });
        await waitFor(() => expect(run).toBeEnabled());
        expect(screen.queryByTestId('cowork-task-held')).toBeNull();
        await user.click(run);
        await waitFor(() => expect(sent('POST', '/api/cowork/w1/run-now')).toBeTruthy());
    });

    it('the first approval is decided on what the test produced: Approve sends the fingerprint of the steps on screen, and no second card asks the same', async () => {
        const { user, sent } = openTask({ plan: PLAN_WAITING, needs: [NEEDS_APPROVAL] });
        const block = await screen.findByTestId('cowork-task-would-receive');
        const approve = await within(block).findByRole('button', { name: 'Approve' });
        expect(screen.queryByTestId('cowork-need-card')).toBeNull();
        // Above Settings: the owner sees it before anything else of the task.
        expect(block.compareDocumentPosition(screen.getByTestId('cowork-task-settings')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        await user.click(approve);
        await waitFor(() => expect(sent('POST', '/api/cowork/w1/plan/approve')?.body).toEqual({ fingerprint: PLAN_WAITING.draft.fingerprint }));
    });

    it('shows what the test produced before the first approval, and "Change something" opens What', async () => {
        const { user } = openTask({ plan: PLAN_WAITING, needs: [NEEDS_APPROVAL] });
        const block = await screen.findByTestId('cowork-task-would-receive');
        expect(within(block).getByRole('heading', { name: 'This is what you would have received' })).toBeInTheDocument();
        expect(block).toHaveTextContent('It would have gone to you. Nothing was sent.');
        expect(within(block).getByTestId('cowork-task-would-receive-text')).toHaveTextContent('Three invoices are overdue. Two meetings moved.');
        expect(screen.queryByLabelText('What should be done?')).toBeNull();
        await user.click(within(block).getByRole('button', { name: 'Change something' }));
        expect(screen.getByLabelText('What should be done?')).toHaveValue('Sum up the week.');
    });

    it('does not show a test result once the steps are approved', async () => {
        openTask();
        await screen.findByTestId('cowork-task-steps');
        expect(screen.queryByTestId('cowork-task-would-receive')).toBeNull();
    });

    it('Undo of a fix Cowork made by itself approves the version before it again', async () => {
        const { user, sent } = openTask({ proposals: [AUTO_FIX] });
        const note = await screen.findByTestId('cowork-task-autofix');
        expect(note).toHaveTextContent('Fixed by itself on');
        expect(note).toHaveTextContent("'Read the mail' was reading the wrong field");
        await user.click(within(note).getByRole('button', { name: 'Undo' }));
        await waitFor(() => expect(sent('POST', '/api/cowork/w1/plan/restore')?.body).toEqual({ version: 1 }));
    });

    it('Share in the header opens the Share row under People', async () => {
        const { user } = openTask({ colleagues: [{ id: 'u2', name: 'Bo Jansen' }] });
        const people = await screen.findByTestId('cowork-task-people');
        const shareRow = () => within(within(people).getByTestId('cowork-task-row-share')).getAllByRole('button')[0];
        expect(shareRow()).toHaveAttribute('aria-expanded', 'false');
        expect(shareRow()).toHaveTextContent('Not shared');
        await user.click(within(screen.getByTestId('cowork-task-actions')).getByRole('button', { name: 'Share' }));
        expect(shareRow()).toHaveAttribute('aria-expanded', 'true');
        expect(await within(people).findByLabelText('Colleague')).toHaveValue('u2');
    });

    it('gives the task away only after the in-page confirmation that says it leaves the list, then closes the page', async () => {
        const { user, sent, close } = openTask({ colleagues: [{ id: 'u2', name: 'Bo Jansen' }] });
        const people = await screen.findByTestId('cowork-task-people');
        await user.click(within(people).getByRole('button', { name: 'Give this task away' }));
        await user.click(await within(people).findByRole('button', { name: 'Give it away…' }));
        expect(within(people).getByTestId('cowork-task-give-confirm')).toHaveTextContent("Give 'Weekly digest' to Bo Jansen? Bo Jansen gets a paused copy and approves its steps first. The task leaves your list, with its runs.");
        expect(sent('POST', '/api/cowork/w1/hand-over')).toBeUndefined();
        await user.click(within(people).getByRole('button', { name: 'Give it away' }));
        await waitFor(() => expect(close).toHaveBeenCalled());
        expect(sent('POST', '/api/cowork/w1/hand-over')?.body).toEqual({ toUserId: 'u2' });
    });

    it('Restore brings an earlier approved version of the steps back through the plan restore route; the current one has no Restore', async () => {
        const audit = [
            { action: 'cowork.plan_approved', at: '2026-11-23T09:00:00.000Z', byYou: true, changed: ['fingerprint', 'version'], values: { version: 2 } },
            { action: 'cowork.plan_approved', at: '2026-11-20T09:00:00.000Z', byYou: true, changed: ['fingerprint', 'version'], values: { version: 1 } },
            { action: 'cowork.updated', at: '2026-11-19T09:00:00.000Z', byYou: true, changed: ['title'], values: {} },
        ];
        const { user, sent } = openTask({ audit });
        const history = await screen.findByTestId('cowork-task-history');
        await user.click(within(history).getByRole('button', { name: /^Changes/ }));
        const changes = await within(history).findAllByTestId('cowork-task-change');
        expect(changes).toHaveLength(3);
        expect(changes[0]).toHaveTextContent('The steps as they are now');
        expect(within(changes[0]).queryByRole('button')).toBeNull();
        expect(within(changes[2]).queryByRole('button')).toBeNull();
        await user.click(within(changes[1]).getByRole('button', { name: 'Restore these steps' }));
        await waitFor(() => expect(sent('POST', '/api/cowork/w1/plan/restore')?.body).toEqual({ version: 1 }));
        expect(await within(history).findByTestId('cowork-task-restored')).toHaveTextContent('Restored.');
    });

    it('says a failed run in plain words, and shows its raw error only under "Technical details"', async () => {
        const raw = 'did not resolve to a parseable date';
        const { user } = openTask({ item: { id: 'w1', title: 'Weekly digest', prompt: 'Sum up the week.', isActive: true, lastStatus: 'error', runCount: 2 }, runs: [FAILED_RUN, RUN] });
        const history = await screen.findByTestId('cowork-task-history');
        await waitFor(() => expect(within(history).getAllByTestId('cowork-task-run')).toHaveLength(2));
        expect(screen.getByTestId('cowork-task-result-text')).toHaveTextContent('It stopped before it was done.');
        expect(within(history).getAllByTestId('cowork-task-run-line')[0]).toHaveTextContent('It stopped before it was done.');
        expect(document.body).not.toHaveTextContent(raw);
        await user.click(within(within(history).getAllByTestId('cowork-task-run')[0]).getByRole('button'));
        expect(within(history).getByTestId('cowork-task-run-detail')).toHaveTextContent('This run stopped before it was done.');
        expect(document.body).not.toHaveTextContent(raw);
        await user.click(within(history).getByRole('button', { name: 'Technical details' }));
        expect(within(history).getByTestId('cowork-task-technical')).toHaveTextContent(raw);
    });

    it('prefers the plain sentence the server gives for a run', async () => {
        const plain = "The step 'A week ago' could not work out its date.";
        openTask({ runs: [{ ...FAILED_RUN, plain }] });
        const history = await screen.findByTestId('cowork-task-history');
        expect(await within(history).findByTestId('cowork-task-run-line')).toHaveTextContent(plain);
    });

    it('has no receipt on the result card: the proof of each run is under History', async () => {
        openTask();
        const result = await screen.findByTestId('cowork-task-result');
        await waitFor(() => expect(result).toHaveTextContent('3 invoices are overdue.'));
        expect(result).not.toHaveTextContent('Receipt');
        expect(within(await screen.findByTestId('cowork-task-history')).getByRole('button', { name: /^Proof of each run/ })).toBeInTheDocument();
    });

    it('deletes only after the in-page confirm at the very bottom, then closes the page', async () => {
        const { user, sent, close } = openTask();
        await user.click(await screen.findByRole('button', { name: 'Delete this task' }));
        expect(screen.getByTestId('cowork-task-delete-confirm')).toHaveTextContent("Delete 'Weekly digest'?");
        expect(sent('DELETE', '/api/cowork/w1')).toBeUndefined();
        await user.click(screen.getByRole('button', { name: 'Keep it' }));
        expect(screen.queryByTestId('cowork-task-delete-confirm')).toBeNull();
        await user.click(screen.getByRole('button', { name: 'Delete this task' }));
        await user.click(screen.getByRole('button', { name: 'Delete task' }));
        await waitFor(() => expect(close).toHaveBeenCalled());
        expect(sent('DELETE', '/api/cowork/w1')).toBeTruthy();
    });

    it('has no Edit screen and no More drawer', async () => {
        openTask();
        await screen.findByTestId('cowork-task-settings');
        for (const name of ['Edit', 'More', 'Run now']) expect(screen.queryByRole('button', { name })).toBeNull();
    });

    it('shows someone else\'s task read only: who shared it, its result, its runs, and no actions', async () => {
        const { calls } = openTask({
            item: null,
            shared: { role: 'viewer', item: { id: 'w1', title: 'Stock check', prompt: 'Check the stock.', repeatInterval: 'daily', nextRunAt: null, lastStatus: 'success', isActive: true, triggerKind: 'schedule' }, runs: [{ id: 'r9', status: 'success', startedAt: '2026-11-23T08:00:00.000Z', result: 'All in stock.', durationMs: 900 }] },
        });
        const shared = await screen.findByTestId('cowork-task-shared');
        expect(await within(shared).findByTestId('cowork-task-shared-by')).toHaveTextContent('Shared by Sam Peters');
        expect(within(shared).getByTestId('cowork-task-when')).toHaveTextContent('as Sam Peters set it up');
        expect(within(shared).getByTestId('cowork-task-result-text')).toHaveTextContent('All in stock.');
        for (const name of ['Run for real now', 'Pause', 'Share', 'Delete this task']) expect(within(shared).queryByRole('button', { name })).toBeNull();
        expect(calls.some((c) => c.method !== 'GET')).toBe(false);
    });
});
