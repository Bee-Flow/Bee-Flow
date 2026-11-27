import { screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ITEM, openTask, readyTaskInput } from './taskWorld.testkit';

afterEach(() => vi.unstubAllGlobals());

it.each([
    ['run', true, 'Run for real now', 'POST', '/api/cowork/w1/run-now'],
    ['pause', true, 'Pause', 'PUT', '/api/cowork/w1'],
    ['resume', false, 'Resume', 'PUT', '/api/cowork/w1'],
] as const)('confirms just the requested %s operation on the named task', async (operation, isActive, label, method, path) => {
    const { user, all } = openTask({item: {...ITEM, isActive}, conversation: () => ({action: operation, answer: 'Please confirm.', instruction: ''})});
    const ask = async () => user.type(await readyTaskInput(), label + '{Enter}');
    await ask();
    const group = await screen.findByRole('group', {name: label});
    expect(group).toHaveTextContent(ITEM.title);
    expect(all(method, path)).toHaveLength(0);
    await user.click(screen.getByRole('button', {name: 'Cancel'}));
    expect(all(method, path)).toHaveLength(0);
    await ask();
    await user.click(await screen.findByRole('button', {name: label}));
    await waitFor(() => expect(all(method, path)).toHaveLength(1));
    if (operation !== 'run') expect(all(method, path)[0]?.body).toEqual({isActive: operation === 'resume'});
});

it('keeps a blocked run on its recovery action', async () => {
    const {user, all} = openTask({item: {...ITEM, lastStatus: 'needs_reauth'}, needs: [{
        kind: 'sign_in', itemId: ITEM.id, title: ITEM.title, connection: {providers: ['google'], canResume: false},
    }], conversation: () => ({action: 'run', answer: 'Check your connection first.', instruction: ''})});
    await user.type(await readyTaskInput(), 'Start it now{Enter}');
    expect(await screen.findByText('Check your connection first.')).toBeVisible();
    expect(screen.getByRole('link', {name: 'Sign in again'})).toBeVisible();
    expect(screen.queryByRole('button', {name: 'Run for real now'})).toBeNull();
    expect(all('POST','/api/cowork/w1/run-now')).toHaveLength(0);
});

it.each([
    ['test', 'Test, sends nothing', 'Compare with last month', 'try'],
    ['compare', 'Compare with last month', 'Test, sends nothing', 'replay'],
] as const)('opens only the requested %s control and waits for a decision', async (action, label, other, endpoint) => {
    const {user, all} = openTask({testProgress: () => ({done: true, status: 'passed', steps: []}), conversation: () => ({action, answer: 'Ready.', instruction: ''})});
    await user.type(await readyTaskInput(), action + '{Enter}');
    const button = await screen.findByRole('button', {name: label});
    expect(screen.queryByRole('button', {name: other})).toBeNull();
    const path = '/api/cowork/w1/plan/' + endpoint;
    expect(all('POST', path)).toHaveLength(0);
    await user.click(button);
    await waitFor(() => expect(all('POST', path)).toHaveLength(1));
});

it('discusses a shared result without owner controls and switches from a direct shared task link', async () => {
    const shared = {role:'viewer', item:ITEM, runs:[]};
    const replies = [
        {action:'answer',answer:'Er zijn drie actiepunten.'},
        {action:'answer',answer:'',tasks:[{id:'w2',title:'Stock',detail:'Colleague',shared:true}],switchTo:'w2'},
    ];
    const {user, open, sent} = openTask({item:null, shared, conversation:() => replies.shift()}, {kind:'shared',id:ITEM.id});
    const input = await readyTaskInput();
    await user.type(input, 'Welke actiepunten komen uit het verslag?{Enter}');
    expect(await screen.findByText('Er zijn drie actiepunten.')).toBeVisible();
    expect(sent('POST','/api/cowork/w1/conversation')?.body).toMatchObject({view:'shared'});
    await user.type(input, 'Ga verder met Stock{Enter}');
    await waitFor(() => expect(open).toHaveBeenCalledWith({kind:'shared',id:'w2'}));
    expect(sent('PUT','/api/cowork/w1')).toBeUndefined();
});

it.each([
    ['new_task', 'Create a daily weather report', 'create'],
    ['attention', 'Which approvals need me?', 'attention'],
    ['shared_tasks', 'Show everything shared with me', 'shared'],
] as const)('moves from a shared task to the reader’s own %s flow', async (action, message, destination) => {
    const shared = {role:'viewer', item:ITEM, runs:[]};
    const {user, fillComposer} = openTask({shared, conversation:() => ({action,answer:'Here you go.'})}, {kind:'shared',id:ITEM.id});
    await user.type(await readyTaskInput(), message + '{Enter}');
    await waitFor(() => expect(fillComposer).toHaveBeenCalledWith(action === 'new_task' ? message : '', destination));
});
