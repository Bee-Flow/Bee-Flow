import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { NEEDS_APPROVAL, openTask, PLAN_WAITING, RUN } from './taskWorld.testkit';

afterEach(() => vi.unstubAllGlobals());

it('opens the latest Markdown result on request, then returns to the step selection', async () => {
    const { user } = openTask();
    expect(await screen.findByRole('button', { name: 'Open result' })).toBeVisible();
    expect(screen.queryByTestId('cowork-task-result-text')).toBeNull();
    expect(screen.queryByRole('tablist')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Open result' }));
    expect(await screen.findByTestId('cowork-task-result-text')).toHaveTextContent('3 invoices');
    await user.click(screen.getByRole('button', { name: 'Back to the orb' }));
    expect(await screen.findByRole('complementary', { name: 'Steps' })).toBeVisible();
    expect(screen.queryByTestId('cowork-task-result-text')).toBeNull();
});

it('asks about two selected steps without proposing an edit, and scopes a requested change to those steps', async () => {
    const { user, sent } = openTask({ conversation: body => {
        const {message} = body as {message: string};
        return message.includes('?') ? {action: 'answer', answer: 'From the mail.', instruction: ''} : {action: 'change', answer: 'I’ll prepare a proposal.', instruction: message};
    } });
    const rail = within(await screen.findByRole('complementary', { name: 'Steps' }));
    await user.click(rail.getByRole('button', { name: /Read the mail/ }));
    await user.click(rail.getByRole('button', { name: /Write the digest/ }));
    await user.type(screen.getByRole('textbox'), 'Where do these inputs come from?');
    await user.click(screen.getByRole('button', { name: 'Send message' }));
    await waitFor(() => expect(sent('POST', '/api/cowork/w1/conversation')?.body).toMatchObject({ message: 'Where do these inputs come from?', scope: { stepIds: expect.arrayContaining(['sum', 'read']), fingerprint: 'f'.repeat(64) } }));
    expect(await screen.findByText('From the mail.')).toBeVisible();
    expect(sent('POST', '/api/cowork/w1/proposals')).toBeUndefined();
    await user.clear(await screen.findByRole('textbox'));
    await user.type(screen.getByRole('textbox'), 'Limit to invoices');
    await user.click(screen.getByRole('button', { name: 'Send message' }));
    await waitFor(() => expect(sent('POST', '/api/cowork/w1/proposals')?.body).toMatchObject({ instruction: 'Limit to invoices', scope: { fingerprint: 'f'.repeat(64), stepIds: expect.arrayContaining(['sum', 'read']) } }));
});

it('keeps talking while reading the result and opens a requested setting in the same conversation', async () => {
    const { user, all } = openTask({ conversation: body => {
        const { message } = body as { message: string };
        return message === 'Show the result' ? { action: 'result', answer: 'Here is the latest run.' }
            : { action: 'when', answer: 'Choose when to run it.' };
    } });
    const input = await screen.findByRole('textbox', { name: 'Ask Bee…' });
    expect(screen.queryByRole('button', { name: 'Adjust this task' })).toBeNull();
    expect(screen.queryByRole('combobox', { name: 'Other task options' })).toBeNull();
    await user.type(input, 'Show the result{Enter}');
    expect(await screen.findByTestId('cowork-task-result-text')).toBeVisible();
    await user.type(input, 'Change the schedule{Enter}');
    expect(await screen.findByTestId('cowork-task-settings')).toBeVisible();
    expect(all('POST', '/api/cowork/w1/conversation')[1]?.body).toMatchObject({
        view: 'result', history: [{ role: 'user', text: 'Show the result' }, { role: 'assistant', text: 'Here is the latest run.' }],
    });
});


it('opens the stopped run directly from its plain-language reason', async () => {
    const {user} = openTask({ runs: [{ ...RUN, status: 'failed', result: '', plain: 'The mailbox needs another sign-in.' }] });
    expect(await screen.findByText('The mailbox needs another sign-in.')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Open result' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'See run details' }));
    expect(within(await screen.findByTestId('cowork-task-run')).getByRole('button', { expanded: true })).toBeVisible();
});

it('shows a quiet result inline when a run had nothing to do', async () => {
    openTask({ runs: [{ ...RUN, producedOutput: false, result: '' }] });
    expect(await screen.findByText('Nothing to do this time.')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Open result' })).toBeNull();
});

it('keeps the actual output and a pending test preview distinct', async () => {
    const { user } = openTask({ plan: PLAN_WAITING, needs: [NEEDS_APPROVAL] });
    await user.click(await screen.findByRole('button', { name: 'Open result' }));
    expect(await screen.findByTestId('cowork-task-result-text')).toHaveTextContent(RUN.result);
    await user.click(screen.getByRole('button', { name: 'Back to the orb' }));
    await user.click(await screen.findByRole('button', { name: 'Review test preview' }));
    expect(await screen.findByTestId('cowork-task-would-receive-text')).toBeVisible();
});

it('keeps an explicit clock change in the conversation and saves it only after confirmation', async () => {
    const schedule = { repeatInterval: 'weekly', timeOfDay: '15:00', daysOfWeek: ['fri'], timezone: 'Europe/Amsterdam', nextRunAt: '2099-11-27T14:00:00.000Z' };
    const {user, all} = openTask({conversation: () => ({action: 'when', answer: 'Here is the new schedule.', schedule})});
    const input = await screen.findByRole('textbox', {name: 'Ask Bee…'});
    await user.type(input, 'Every Friday at 15:00 please{Enter}');
    const apply = await screen.findByRole('button', {name: 'Apply schedule'});
    expect(screen.queryByTestId('cowork-task-settings')).toBeNull();
    expect(all('PUT', '/api/cowork/w1')).toHaveLength(0);
    await user.click(apply);
    await waitFor(() => expect(all('PUT', '/api/cowork/w1').map(call => call.body)).toEqual([schedule]));
});

it('places the sign-in notice above the orb and opens integrations directly from its side', async () => {
    openTask({needs: [{...NEEDS_APPROVAL, kind: 'sign_in', plan: null}], runs: []});
    const notice = await screen.findByText(/The task is paused for sign-in/);
    const orb = notice.closest('.cowork-activity')?.querySelector('.cowork-orb');
    expect(orb).toBeTruthy();
    expect(notice.compareDocumentPosition(orb as Element) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const action = screen.getByRole('link', {name: 'Sign in again'});
    expect(action.getAttribute('href')).toContain('integrations');
    expect(action.closest('.cowork-workspace-steps')).not.toBeNull();
    expect(screen.queryByRole('button', {name: 'Review task'})).toBeNull();
});

it('shows the requested settings beside Bee until the user chooses one', async () => {
    const {user} = openTask({conversation: () => ({action:'answer', answer:'Which setting?', choices:['when','uses']})});
    await user.type(await screen.findByRole('textbox', {name:'Ask Bee…'}), 'Adjust the settings{Enter}');
    const menu = within(await screen.findByRole('navigation', {name:'Settings'}));
    expect(menu.getAllByRole('button')).toHaveLength(2);
    expect(screen.queryByRole('complementary', {name:'Steps'})).toBeNull();
    await user.click(menu.getByRole('button', {name:'Schedule'}));
    expect(await screen.findByTestId('cowork-task-settings')).toBeVisible();
    expect(screen.queryByRole('navigation', {name:'Settings'})).toBeNull();
});

it('sends a named removal to the proposal endpoint without modifying the task directly', async () => {
    const remove = {stepIds:['tell'], fingerprint:'f'.repeat(64)};
    const {user, sent} = openTask({conversation: () => ({action:'change', answer:'Preparing a change.', instruction:'Remove Tell me', remove})});
    await user.type(await screen.findByRole('textbox', {name:'Ask Bee…'}), 'Remove the notification step{Enter}');
    await waitFor(() => expect(sent('POST', '/api/cowork/w1/proposals')?.body).toEqual({remove}));
    expect(sent('PUT','/api/cowork/w1')).toBeUndefined();
});

it('resumes a task paused for an unrelated account from beside Bee', async () => {
    const {user, sent} = openTask({needs: [{...NEEDS_APPROVAL, kind: 'sign_in', plan: null, connection: {canResume: true, providers: []}}]});
    expect(await screen.findByText(/without signing in again/)).toBeVisible();
    await user.click(screen.getByRole('button', {name: 'Resume'}));
    await waitFor(() => expect(sent('PUT', '/api/cowork/w1')?.body).toEqual({isActive: true}));
});

it('shows other work in place and opens a chosen shared task in its own view', async () => {
    const {user, open} = openTask({conversation: () => ({action:'answer', answer:'', tasks:[{id:'shared',title:'Meeting digest',detail:'Noor',shared:true}]})});
    await user.type(await screen.findByRole('textbox', {name:'Ask Bee…'}), 'What other tasks are there?{Enter}');
    expect(open).not.toHaveBeenCalled();
    await user.click(within(await screen.findByRole('navigation', {name:'Tasks'})).getByRole('button', {name:/Meeting digest/}));
    expect(open).toHaveBeenCalledWith({kind:'shared', id:'shared'});
});
