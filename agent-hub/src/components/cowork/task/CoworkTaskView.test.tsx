// The opened task (./CoworkTaskView.tsx) against a recording fetch (./taskWorld.testkit.tsx), no module mocked: its
// steps in run order with the in-between steps folded and the recipient named, "Run for real now" held back with the
// reason said, what the test produced before the first approval, Share and Give away under People, Restore, Delete
// and raw errors under History, and someone else's task read only.
import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { softClasses } from '../crisp.testkit';
import { ITEM, NEEDS_APPROVAL, NO_PLAN, PLAN_WAITING, RUN, openAdvancedTask, openTask } from './taskWorld.testkit';

const AUTO_FIX = {
    id: 'pr-auto', kind: 'repair', reasonCode: 'reference_fixed', stepId: 'read', stepTitle: 'Read the mail', status: 'approved', fingerprint: 'f'.repeat(64),
    createdAt: null, decidedAt: '2026-11-24T08:00:00.000Z', changes: [], widens: [], replay: null, undoVersion: 1,
};
const FAILED_RUN = { id: 'r0', status: 'error', startedAt: '2026-11-22T08:00:00.000Z', error: 'datetime: input "{{steps.dtac3ed7.output.iso}}" did not resolve to a parseable date' };

afterEach(() => { vi.unstubAllGlobals(); });

async function selectTab(user: ReturnType<typeof openTask>['user'], name: string) {
    await user.click(await screen.findByRole('tab', { name }));
    return screen.getByRole('tabpanel', { name });
}

describe('the task page is crisp', () => {
    it('nothing that holds text carries a transform, a filter or a backdrop filter at rest: closed, and with every row opened', async () => {
        const { user } = await openAdvancedTask({ plan: PLAN_WAITING, needs: [NEEDS_APPROVAL], runs: [FAILED_RUN, RUN], colleagues: [{ id: 'u2', name: 'Bo Jansen' }] });
        const page = await screen.findByTestId('cowork-task-view');
        await screen.findByTestId('cowork-task-would-receive');
        await waitFor(() => expect(within(page).getAllByTestId('cowork-task-run')).toHaveLength(2));
        expect(softClasses(page)).toEqual([]);
        const rowsByTab = {
            Settings: ['cowork-task-setting-what', 'cowork-task-setting-when', 'cowork-task-setting-uses', 'cowork-task-setting-sends'],
            People: ['cowork-task-row-share', 'cowork-task-row-pass', 'cowork-task-row-template', 'cowork-task-row-give'],
            History: ['cowork-task-row-changes', 'cowork-task-row-proof'],
        };
        for (const [tab, ids] of Object.entries(rowsByTab)) {
            const panel = await selectTab(user, tab);
            for (const id of ids) {
                const head = within(within(panel).getByTestId(id)).getAllByRole('button')[0];
                await user.click(head);
                expect(head).toHaveAttribute('aria-expanded', 'true');
                expect(softClasses(panel), id).toEqual([]);
            }
        }
        await user.click(within(within(page).getAllByTestId('cowork-task-run')[0]).getByRole('button'));
        await user.click(within(page).getByRole('button', { name: 'Technical details' }));
        await user.click(within(page).getByRole('button', { name: 'Delete this task' }));
        expect(softClasses(page)).toEqual([]);
    });
});

describe('CoworkTaskView', () => {
    it('shows one activity indicator for a running task', async () => {
        await openAdvancedTask({ item: { ...ITEM, lastStatus: 'running' }, runs: [{ ...RUN, status: 'running' }] });
        const progress = await screen.findByTestId('cowork-task-progress');
        expect(screen.getByTestId('cowork-task-header')).toHaveTextContent('Running');
        expect(progress).toBeVisible();
        expect(screen.getByTestId('cowork-task-view').querySelector('.cowork-task-anchor .cowork-orb')).toBeVisible();
        expect(screen.getByTestId('cowork-task-view').querySelectorAll('.cowork-orb')).toHaveLength(1);
    });

    it('only shows the selected panel and supports keyboard navigation between tabs', async () => {
        const { user } = await openAdvancedTask();
        const result = await screen.findByRole('tab', { name: 'Result', selected: true });
        const panel = screen.getByRole('tabpanel', { name: 'Result' });
        expect(result).toHaveAttribute('aria-controls', panel.id);
        expect(panel).toHaveAttribute('aria-labelledby', result.id);
        expect(screen.getByTestId('cowork-task-settings')).not.toBeVisible();
        result.focus();
        await user.keyboard('{ArrowRight}');
        expect(screen.getByRole('tab', { name: 'Settings', selected: true })).toHaveFocus();
        expect(panel).not.toBeVisible();
        expect(screen.getByRole('tabpanel', { name: 'Settings' })).toBeVisible();
    });

    it('renders an existing JSON-wrapped Markdown result on the Result tab and in its history row', async () => {
        const result = JSON.stringify({ answer: '# Weekoverzicht meetings\n\n- **Veiligheid**\n- Actiepunten' });
        const { user } = await openAdvancedTask({ runs: [{ ...RUN, result }] });
        const latest = within(await screen.findByRole('tabpanel', { name: 'Result' }));
        expect(await latest.findByRole('heading', { name: 'Weekoverzicht meetings' })).toBeVisible();
        expect(latest.getAllByRole('listitem')).toHaveLength(2);
        expect(latest.getByText('Veiligheid', { selector: 'strong' })).toBeVisible();

        const history = within(await selectTab(user, 'History'));
        expect(history.getByTestId('cowork-task-run-line')).toHaveTextContent(/^Weekoverzicht meetings$/);
        await user.click(within(history.getByTestId('cowork-task-run')).getByRole('button'));
        expect(history.getByRole('heading', { name: 'Weekoverzicht meetings' })).toBeVisible();
        expect(history.getByText('Veiligheid', { selector: 'strong' })).toBeVisible();
    });

    it('opens the Steps tab from a steps shortcut and shows them in run order with in-between steps folded', async () => {
        const { user } = await openAdvancedTask({}, { kind: 'task', id: 'w1', focus: 'steps' });
        expect(await screen.findByRole('tabpanel', { name: 'Steps' })).toBeVisible();
        const steps = await screen.findByTestId('cowork-task-steps');
        await waitFor(() => expect(within(steps).getAllByTestId('cowork-task-step')).toHaveLength(3));
        expect(within(steps).getAllByTestId('cowork-task-step').map((li) => li.textContent)).toEqual([
            expect.stringContaining('Read the mail'), expect.stringContaining('Write the digest'), expect.stringContaining('Tell me'),
        ]);
        expect(within(steps).getAllByTestId('cowork-task-step-word').at(-1)).toHaveTextContent('Sends to you');
        expect(within(steps).getAllByTestId('cowork-task-step')[0].querySelector('svg')).toHaveAttribute('viewBox', '0 0 48 48');
        await user.click(within(steps).getByRole('button', { name: 'Details' }));
        expect(within(steps).getByText('Keep this week')).toBeVisible();
        expect(within(steps).getAllByTestId('cowork-task-step')).toHaveLength(3);
        expect(within(steps).getByRole('button', { name: 'Test, sends nothing' })).toBeEnabled();
        expect(within(steps).getByRole('button', { name: 'Compare with last month' })).toBeEnabled();
    });

    it('shows the running test step on the Steps tab and follows it to completion', async () => {
        let done = false;
        const testProgress = () => ({ tryId: 'try-1', done, steps: [
            { id: 'read', title: 'Read the mail', status: 'success' },
            { id: 'trim', title: 'Keep this week', status: done ? 'success' : 'running' },
            { id: 'tell', title: 'Tell me', status: done ? 'success' : 'pending' },
        ] });
        const { user } = await openAdvancedTask({ testProgress }, { kind: 'task', id: 'w1', focus: 'steps' });
        const panel = within(await screen.findByRole('tabpanel', { name: 'Steps' }));
        await user.click(await panel.findByRole('button', { name: 'Test, sends nothing' }));
        expect(await panel.findByText('I’m testing step 2 of 3: Keep this week')).toBeVisible();
        await user.click(panel.getByText('Details', { selector: 'summary' }));
        expect(panel.getByText('Keep this week').closest('li')).toHaveAttribute('aria-current', 'step');
        expect(panel.getByText('Tell me').closest('li')).toHaveTextContent('Waiting');
        done = true;
        await waitFor(() => expect(panel.getByTestId('cowork-task-tested')).toHaveTextContent('Tested just now'), { timeout: 4000 });
    });

    it('groups mail reads around a mapped script and keeps the write visible as its own stage', async () => {
        const plan = structuredClone(PLAN_WAITING);
        const view = plan.draft.view;
        const read = view.steps.find(step => step.id === 'read')!;
        view.steps.push(
            { ...read, id: 'search', title: 'Search messages' },
            { ...read, id: 'save', title: 'Save the digest', effect: 'writes' },
        );
        Object.assign(view.steps.find(step => step.id === 'trim')!, {
            type: 'code', title: 'Select messages', inputNames: ['messages'], description: 'Filter by date.',
        });
        view.runOrder = ['read', 'trim', 'search', 'sum', 'save', 'tell'];
        const { user } = await openAdvancedTask({ plan }, { kind: 'task', id: 'w1', focus: 'steps' });
        const panel = within(await screen.findByRole('tabpanel', { name: 'Steps' }));
        await panel.findByText('Read from Outlook');
        expect(panel.getAllByTestId('cowork-task-step')).toHaveLength(4);
        expect(panel.getByText('Save the digest')).toBeVisible();
        expect(panel.queryByText('Select messages')).toBeNull();
        await user.click(panel.getByRole('button', { name: 'Details' }));
        expect(panel.getByText('Filter by date.')).toBeVisible();
        expect(panel.getByText('Inputs: messages')).toBeVisible();
        expect(panel.getByText('Search messages')).toBeVisible();
    });

    it('shows the Fireflies logo and keeps the action icon for an app without a registered icon', async () => {
        const { user } = await openAdvancedTask({ plan: NO_PLAN, runs: [{ ...RUN, activity: { tools: [
            { name: 'fireflies_list_transcripts', label: 'List meetings', app: 'fireflies', effect: 'reads', ok: 1 },
            { name: 'internal_reader', label: 'Read archives', app: 'archive-connector', effect: 'reads', ok: 1 },
        ] } }] });
        const steps = within(await selectTab(user, 'Steps'));
        await steps.findByText('List meetings');
        const [fireflies, archive, ai] = steps.getAllByTestId('cowork-task-step');
        expect(fireflies).toHaveTextContent('Reads · Fireflies');
        expect(fireflies.querySelector('svg')).toHaveAttribute('viewBox', '22 20 24 24');
        expect(archive).toHaveTextContent('Reads · Archive connector');
        expect(archive.querySelector('svg')).toHaveClass('lucide-file-search');
        expect(ai).toHaveTextContent('AI');
    });

    it('offers the approval while its steps wait and explains why they cannot run yet', async () => {
        await openAdvancedTask({ plan: PLAN_WAITING, needs: [NEEDS_APPROVAL] });
        await screen.findByTestId('cowork-task-would-receive');
        expect(screen.queryByRole('button', { name: 'Run for real now' })).toBeNull();
        expect(screen.getByTestId('cowork-task-held')).toHaveTextContent('It cannot run for real yet: its steps wait for your approval.');
    });

    it('runs for real when nothing waits, and says nothing is held back', async () => {
        const { user, sent } = await openAdvancedTask();
        const run = await screen.findByRole('button', { name: 'Run for real now' });
        await waitFor(() => expect(run).toBeEnabled());
        expect(screen.queryByTestId('cowork-task-held')).toBeNull();
        await selectTab(user, 'History');
        await user.click(run);
        await waitFor(() => expect(sent('POST', '/api/cowork/w1/run-now')).toBeTruthy());
        expect(screen.getByRole('tab', { name: 'Result', selected: true })).toHaveFocus();
    });

    it('the first approval is decided on what the test produced: Approve sends the fingerprint of the steps on screen, and no second card asks the same', async () => {
        const { user, sent } = await openAdvancedTask({ plan: PLAN_WAITING, needs: [NEEDS_APPROVAL] });
        const block = await screen.findByTestId('cowork-task-would-receive');
        const approve = await within(block).findByRole('button', { name: 'Approve' });
        expect(screen.queryByTestId('cowork-need-card')).toBeNull();
        expect(screen.getByRole('tabpanel', { name: 'Result' })).toContainElement(block);
        await user.click(approve);
        await waitFor(() => expect(sent('POST', '/api/cowork/w1/plan/approve')?.body).toEqual({ fingerprint: PLAN_WAITING.draft.fingerprint }));
    });

    it('shows what the test produced before the first approval, and "Change something" opens What', async () => {
        const { user } = await openAdvancedTask({ plan: PLAN_WAITING, needs: [NEEDS_APPROVAL] });
        const block = await screen.findByTestId('cowork-task-would-receive');
        expect(within(block).getByRole('heading', { name: 'This is what you would have received' })).toBeInTheDocument();
        expect(block).toHaveTextContent('It would have gone to you. Nothing was sent.');
        expect(within(block).getByTestId('cowork-task-would-receive-text')).toHaveTextContent('Three invoices are overdue. Two meetings moved.');
        expect(screen.queryByLabelText('What should be done?')).toBeNull();
        await user.click(within(block).getByText('Advanced'));
        await user.click(within(block).getByRole('button', { name: 'Change something' }));
        expect(screen.getByRole('tab', { name: 'Settings', selected: true })).toHaveFocus();
        expect(screen.getByLabelText('What should be done?')).toHaveValue('Sum up the week.');
    });

    it('does not show a test result once the steps are approved', async () => {
        await openAdvancedTask();
        await screen.findByTestId('cowork-task-steps');
        expect(screen.queryByTestId('cowork-task-would-receive')).toBeNull();
    });

    it('Undo of a fix Cowork made by itself approves the version before it again', async () => {
        const { user, sent } = await openAdvancedTask({ proposals: [AUTO_FIX] });
        const note = await screen.findByTestId('cowork-task-autofix');
        expect(note).toHaveTextContent('Fixed by itself on');
        expect(note).toHaveTextContent("'Read the mail' was reading the wrong field");
        await user.click(within(note).getByRole('button', { name: 'Undo' }));
        await waitFor(() => expect(sent('POST', '/api/cowork/w1/plan/restore')?.body).toEqual({ version: 1 }));
    });

    it('Share in the header opens the Share row under People', async () => {
        const { user } = await openAdvancedTask({ colleagues: [{ id: 'u2', name: 'Bo Jansen' }] });
        await selectTab(user, 'People');
        const people = await screen.findByTestId('cowork-task-people');
        const shareRow = () => within(within(people).getByTestId('cowork-task-row-share')).getAllByRole('button')[0];
        expect(shareRow()).toHaveAttribute('aria-expanded', 'false');
        expect(shareRow()).toHaveTextContent('Not shared');
        await selectTab(user, 'Result');
        await user.click(screen.getByText('Task actions'));
        await user.click(within(screen.getByTestId('cowork-task-actions')).getByRole('button', { name: 'Share' }));
        expect(screen.getByRole('tab', { name: 'People', selected: true })).toHaveFocus();
        expect(shareRow()).toHaveAttribute('aria-expanded', 'true');
        expect(await within(people).findByLabelText('Colleague')).toHaveValue('u2');
    });

    it('gives the task away only after the in-page confirmation that says it leaves the list, then closes the page', async () => {
        const { user, sent, close } = await openAdvancedTask({ colleagues: [{ id: 'u2', name: 'Bo Jansen' }] });
        await selectTab(user, 'People');
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
        const { user, sent } = await openAdvancedTask({ audit });
        await selectTab(user, 'History');
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
        const { user } = await openAdvancedTask({ item: { id: 'w1', title: 'Weekly digest', prompt: 'Sum up the week.', isActive: true, lastStatus: 'error', runCount: 2 }, runs: [FAILED_RUN, RUN] });
        const history = await screen.findByTestId('cowork-task-history');
        await waitFor(() => expect(within(history).getAllByTestId('cowork-task-run')).toHaveLength(2));
        expect(screen.getByTestId('cowork-task-result-text')).toHaveTextContent('It stopped before it was done.');
        await selectTab(user, 'History');
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
        await openAdvancedTask({ runs: [{ ...FAILED_RUN, plain }] });
        const history = await screen.findByTestId('cowork-task-history');
        expect(await within(history).findByTestId('cowork-task-run-line')).toHaveTextContent(plain);
    });

    it('has no receipt on the result card: the proof of each run is under History', async () => {
        const { user } = await openAdvancedTask();
        const result = await screen.findByTestId('cowork-task-result');
        await waitFor(() => expect(result).toHaveTextContent('3 invoices are overdue.'));
        expect(result).not.toHaveTextContent('Receipt');
        const history = await selectTab(user, 'History');
        expect(within(history).getByRole('button', { name: /^Proof of each run/ })).toBeInTheDocument();
    });

    it('deletes only after the in-page confirm at the very bottom, then closes the page', async () => {
        const { user, sent, close } = await openAdvancedTask();
        await selectTab(user, 'History');
        await user.click(screen.getByRole('button', { name: 'Delete this task' }));
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
        const { user } = await openAdvancedTask();
        await selectTab(user, 'Settings');
        for (const name of ['Edit', 'More', 'Run now']) expect(screen.queryByRole('button', { name })).toBeNull();
    });

    it('shows someone else\'s task read only: who shared it, its result, its runs, and no actions', async () => {
        const { calls, user } = openTask({
            item: null,
            shared: { role: 'viewer', item: { id: 'w1', title: 'Stock check', prompt: 'Check the stock.', repeatInterval: 'daily', nextRunAt: null, lastStatus: 'success', isActive: true, triggerKind: 'schedule' }, runs: [{ id: 'r9', status: 'success', startedAt: '2026-11-23T08:00:00.000Z', result: 'All in stock.', durationMs: 900 }] },
        });
        const shared = await screen.findByTestId('cowork-task-shared');
        expect(await within(shared).findByTestId('cowork-task-shared-by')).toHaveTextContent('Shared by Sam Peters');
        expect(within(shared).getByTestId('cowork-task-when')).toHaveTextContent('as Sam Peters set it up');
        const bee = within(shared).getByRole('textbox', { name: 'Ask Bee…' });
        await user.type(bee, 'Toon de eerdere uitvoeringen{Enter}');
        expect(within(shared).getByTestId('cowork-task-runs')).toHaveTextContent('All in stock.');
        await user.type(bee, 'Verwijder deze taak{Enter}');
        expect(within(shared).getByText('Only the owner can change this shared task.')).toBeVisible();
        await user.type(bee, 'Toon het resultaat{Enter}');
        expect(within(shared).getByTestId('cowork-task-result-text')).toHaveTextContent('All in stock.');
        await user.click(within(shared).getByRole('button', { name: 'Advanced' }));
        expect(within(shared).getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['Result', 'History']);
        expect(within(await selectTab(user, 'History')).getByTestId('cowork-task-run-line')).toHaveTextContent('All in stock.');
        for (const name of ['Run for real now', 'Pause', 'Share', 'Delete this task']) expect(within(shared).queryByRole('button', { name })).toBeNull();
        expect(calls.some((c) => c.method !== 'GET')).toBe(false);
    });
});
