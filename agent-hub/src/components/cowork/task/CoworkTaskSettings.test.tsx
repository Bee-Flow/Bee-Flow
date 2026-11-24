// The Settings of an opened task (./CoworkTaskSettings.tsx), on the page itself and against a recording fetch
// (./taskWorld.testkit.tsx): each of the four rows always shows its value, opens in place one at a time, and saves
// through its own route. "Save" for what leaves the steps alone, "Save and test" for what makes them again; the one
// "Ask me" choice maps to the three levels; the apps chips save `enabledApps`.
import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { INDEPENDENCE, ITEM, NO_PLAN, PLAN_WAITING, openTask } from './taskWorld.testkit';

afterEach(() => { vi.unstubAllGlobals(); });

const row = (id: string) => screen.findByTestId(`cowork-task-setting-${id}`);
const value = (id: string) => screen.getByTestId(`cowork-task-setting-${id}-value`);
/** Open a row by its button (the first button in it: its name, its value and "Change"). */
async function openRow(user: ReturnType<typeof openTask>['user'], id: string) {
    const el = await row(id);
    await user.click(within(el).getAllByRole('button')[0]);
    return el;
}
const TASK = '/api/cowork/w1';

describe('CoworkTaskSettings', () => {
    it('shows the current value of all four rows in plain words while they are closed', async () => {
        openTask();
        await row('what');
        expect(value('what')).toHaveTextContent('Sum up the week.');
        expect(value('when')).toHaveTextContent('09:00');
        await waitFor(() => expect(value('uses')).toHaveTextContent('Outlook · Fixed steps'));
        await waitFor(() => expect(value('sends')).toHaveTextContent('You'));
        await waitFor(() => expect(screen.getByTestId('cowork-task-setting-sends')).toHaveTextContent('Show me each message first'));
        for (const id of ['what', 'when', 'uses', 'sends']) expect(within(screen.getByTestId(`cowork-task-setting-${id}`)).getAllByRole('button')[0]).toHaveAttribute('aria-expanded', 'false');
    });

    it('opens one row at a time, in place', async () => {
        const { user } = openTask();
        const what = await openRow(user, 'what');
        expect(within(what).getByLabelText('Name')).toHaveValue('Weekly digest');
        const when = await openRow(user, 'when');
        expect(within(when).getByLabelText('It starts')).toHaveValue('schedule');
        expect(within(what).queryByLabelText('Name')).toBeNull();
        expect(within(what).getAllByRole('button')[0]).toHaveAttribute('aria-expanded', 'false');
    });

    it('What: a new name is "Save", sent at once as the name and the sentence only, and the steps stay', async () => {
        const { user, sent } = openTask();
        const what = await openRow(user, 'what');
        expect(within(what).getByRole('button', { name: 'Save' })).toBeDisabled();
        await user.type(within(what).getByLabelText('Name'), ' on Monday');
        expect(within(what).getByTestId('cowork-task-save-note')).toHaveTextContent('Saved at once. The steps stay as they are.');
        await user.click(within(what).getByRole('button', { name: 'Save' }));
        await waitFor(() => expect(sent('PUT', TASK)?.body).toEqual({ title: 'Weekly digest on Monday', prompt: 'Sum up the week.' }));
        expect(sent('POST', `${TASK}/plan/make`)).toBeUndefined();
        await waitFor(() => expect(within(what).queryByLabelText('Name')).toBeNull());
    });

    it('What: a new sentence for fixed steps says before saving that the steps are rebuilt and tested, then does it', async () => {
        const { user, sent } = openTask();
        const what = await openRow(user, 'what');
        await user.type(within(what).getByLabelText('What should be done?'), ' Add the open invoices.');
        expect(within(what).queryByRole('button', { name: 'Save' })).toBeNull();
        expect(within(what).getByTestId('cowork-task-save-note')).toHaveTextContent('Cowork rebuilds the steps and tests them once. Nothing is sent. You approve the changed steps before it runs again.');
        expect(sent('PUT', TASK)).toBeUndefined();
        await user.click(within(what).getByRole('button', { name: 'Save and test' }));
        await waitFor(() => expect(sent('POST', `${TASK}/plan/make`)).toBeTruthy());
        expect(sent('PUT', TASK)?.body).toEqual({ title: 'Weekly digest', prompt: 'Sum up the week. Add the open invoices.' });
    });

    it('What: the target to track is saved by itself, through the goal route', async () => {
        const { user, sent } = openTask();
        const what = await openRow(user, 'what');
        const target = within(what).getByTestId('cowork-task-target');
        expect(target).toHaveTextContent('Target to track');
        expect(target).toHaveTextContent('Public holidays count as working days.');
        await user.type(within(target).getByLabelText('What should this task achieve? One sentence.'), 'Every invoice chased within a week');
        await user.click(within(target).getByRole('button', { name: 'Save target' }));
        await waitFor(() => expect(sent('PUT', `${TASK}/goal`)?.body).toEqual({ sentence: 'Every invoice chased within a week', targetPercent: 100 }));
        expect(sent('PUT', TASK)).toBeUndefined();
    });

    it('When: another schedule is "Save", sent as the clock only', async () => {
        const { user, sent } = openTask();
        const when = await openRow(user, 'when');
        await user.selectOptions(within(when).getByLabelText('How often'), 'daily');
        await user.click(within(when).getByRole('button', { name: 'Save' }));
        await waitFor(() => expect(sent('PUT', TASK)).toBeTruthy());
        expect(sent('PUT', TASK)?.body).toMatchObject({ triggerKind: 'schedule', repeatInterval: 'daily', timeOfDay: '09:00', daysOfWeek: null });
        expect(sent('PUT', TASK)?.body).not.toHaveProperty('title');
        expect(sent('PUT', `${TASK}/start`)).toBeUndefined();
    });

    it('When: every start is offered, a mail start says it only drafts, and a webhook is "Save and test" through the start route', async () => {
        const { user, sent } = openTask();
        const when = await openRow(user, 'when');
        const kinds = within(when).getByLabelText('It starts');
        expect(within(kinds).getAllByRole('option').map((o) => o.textContent)).toEqual([
            'On a schedule', 'When a new e-mail arrives', 'After another task finishes', 'When a table gets a new row', 'When a new file lands in a folder', 'When another system calls it (webhook)',
        ]);
        await user.selectOptions(kinds, 'email');
        expect(when).toHaveTextContent('A task that starts from a mail only drafts its reply');
        await user.selectOptions(kinds, 'webhook');
        await user.click(within(when).getByRole('button', { name: 'Save and test' }));
        await waitFor(() => expect(sent('PUT', `${TASK}/start`)?.body).toEqual({ kind: 'webhook' }));
        expect(sent('PUT', TASK)).toBeUndefined();
    });

    it('Uses: the apps are chips, and switching one on saves the task\'s own list as enabledApps', async () => {
        const { user, sent } = openTask({ plan: NO_PLAN });
        const uses = await openRow(user, 'uses');
        const chip = await within(uses).findByRole('button', { name: 'OneDrive' });
        expect(chip).toHaveAttribute('aria-pressed', 'false');
        await user.click(chip);
        expect(chip).toHaveAttribute('aria-pressed', 'true');
        await user.click(within(uses).getByRole('button', { name: 'Save' }));
        await waitFor(() => expect(sent('PUT', TASK)?.body).toEqual({ agentId: null, enabledApps: ['outlook', 'onedrive'] }));
    });

    it('Uses: other apps for fixed steps are "Save and test"', async () => {
        const { user, sent } = openTask();
        const uses = await openRow(user, 'uses');
        await user.click(await within(uses).findByRole('button', { name: 'OneDrive' }));
        await user.click(within(uses).getByRole('button', { name: 'Save and test' }));
        await waitFor(() => expect(sent('POST', `${TASK}/plan/make`)).toBeTruthy());
        expect(sent('PUT', TASK)?.body).toEqual({ agentId: null, enabledApps: ['outlook', 'onedrive'] });
    });

    it('Uses: fixed steps back to the AI is "Save", says before saving that the steps are taken off, and takes them off', async () => {
        const { user, sent } = openTask();
        const uses = await openRow(user, 'uses');
        await user.click(within(uses).getByRole('radio', { name: 'The AI works it out every run' }));
        expect(within(uses).getByTestId('cowork-task-save-note')).toHaveTextContent('Saving takes its fixed steps off: from then on the task is worked out again on every run.');
        expect(sent('DELETE', `${TASK}/plan`)).toBeUndefined();
        await user.click(within(uses).getByRole('button', { name: 'Save' }));
        await waitFor(() => expect(sent('DELETE', `${TASK}/plan`)).toBeTruthy());
        expect(sent('POST', `${TASK}/plan/make`)).toBeUndefined();
    });

    it('Uses: a task the AI does becomes fixed steps with "Save and test", where the organisation has automations', async () => {
        const { user, sent } = openTask({ plan: NO_PLAN, automations: true });
        const uses = await openRow(user, 'uses');
        expect(within(uses).getByRole('radio', { name: 'The AI works it out every run' })).toBeChecked();
        await user.click(within(uses).getByRole('radio', { name: 'Fixed steps' }));
        await user.click(within(uses).getByRole('button', { name: 'Save and test' }));
        await waitFor(() => expect(sent('POST', `${TASK}/plan/make`)).toBeTruthy());
    });

    it('Uses: holds what it remembers and its spending limit, and the limit saves by itself', async () => {
        const { user, sent } = openTask();
        const uses = await openRow(user, 'uses');
        expect(within(uses).getByTestId('cowork-task-remembers')).toHaveTextContent('What it remembers');
        const limit = within(uses).getByTestId('cowork-task-limit');
        expect(limit).toHaveTextContent('Spending limit');
        await user.type(within(limit).getByLabelText('Monthly limit in euros'), '20');
        await user.click(within(limit).getByRole('button', { name: 'Save limit' }));
        await waitFor(() => expect(sent('PUT', TASK)?.body).toEqual({ monthlyBudget: 20 }));
    });

    it('Sends to: the one "Ask me" choice maps to the three levels of independence', async () => {
        const { user, all } = openTask();
        const sends = await openRow(user, 'sends');
        expect(within(sends).getByTestId('cowork-task-recipients')).toHaveTextContent('You');
        const ask = within(sends).getByTestId('cowork-task-ask');
        await waitFor(() => expect(within(ask).getByRole('radio', { name: /Show me each message first/ })).toBeChecked());
        const choices: Array<[RegExp, string]> = [
            [/Ask me before every change or message/, 'asks_everything'],
            [/Don't ask/, 'on_its_own'],
            [/Show me each message first/, 'asks_before_sending'],
        ];
        for (const [name, level] of choices) {
            await user.click(within(ask).getByRole('radio', { name }));
            await waitFor(() => expect(all('PUT', `${TASK}/plan/independence`).at(-1)?.body).toEqual({ level }));
            await waitFor(() => expect(within(ask).getByRole('radio', { name })).toBeChecked());
        }
        expect(all('PUT', `${TASK}/plan/independence`)).toHaveLength(3);
    });

    it('Sends to: a level that is not open yet is off and says why', async () => {
        const options = INDEPENDENCE.options.map((o) => (o.level === 'on_its_own' ? { ...o, open: false } : o));
        const { user } = openTask({ independence: { ...INDEPENDENCE, letThrough: 3, options } });
        const sends = await openRow(user, 'sends');
        const off = await within(sends).findByRole('radio', { name: /Don't ask/ });
        await waitFor(() => expect(off).toBeDisabled());
        expect(sends).toHaveTextContent("Don't ask opens after 10 runs you let through without stopping one (3 so far).");
    });

    it('Sends to: is there before the steps are approved too, switched off, with one line that says why', async () => {
        const { user, sent } = openTask({ plan: PLAN_WAITING });
        await row('sends');
        await waitFor(() => expect(screen.getByTestId('cowork-task-setting-sends')).toHaveTextContent('Asking first starts once its steps are approved'));
        const sends = await openRow(user, 'sends');
        expect(within(sends).getByTestId('cowork-task-ask-why')).toHaveTextContent('This starts to apply once you approved its steps.');
        for (const radio of within(sends).getAllByRole('radio')) expect(radio).toBeDisabled();
        expect(sent('PUT', `${TASK}/plan/independence`)).toBeUndefined();
    });

    it('Sends to: for a task the AI does it says that asking first belongs to fixed steps', async () => {
        const { user } = openTask({ plan: NO_PLAN, item: { ...ITEM, enabledApps: null } });
        const sends = await openRow(user, 'sends');
        expect(within(sends).getByTestId('cowork-task-ask-why')).toHaveTextContent('This applies to fixed steps.');
        await waitFor(() => expect(value('uses')).toHaveTextContent('The AI works it out every run'));
    });
});
