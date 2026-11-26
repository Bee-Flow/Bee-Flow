// The composer of the Cowork home and its ONE confirmation card (./CoworkHomeComposer.tsx, ./CoworkConfirmCard.tsx):
// "Preview task" works the sentence out, the card says What, When, Uses and Sends to and lets each be
// changed, an edit of the sentence updates the card without losing what was changed by hand, and "Set up and test"
// creates the task with what the card shows. The network is the seam (a recording fetch).
import type { ReactElement } from 'react';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithClient } from '@/test/render';
import { jsonResponse, stubRecordingFetch, type RecordedCall } from '@/test/recordingFetch';
import CoworkHomeComposer from './CoworkHomeComposer';
import { softClasses } from './crisp.testkit';
import EntitlementsContext, { type EntitlementsValue } from '../licensing/EntitlementsContext';
import type { CoworkItem, CoworkSpec } from '@/api/cowork.types';

let calls: RecordedCall[];
const pathOf = (call: RecordedCall): string => new URL(call.url, 'http://x').pathname;
const created = (): RecordedCall | undefined => calls.find((c) => c.method === 'POST' && pathOf(c) === '/api/cowork');
const composed = (): RecordedCall[] => calls.filter((c) => pathOf(c) === '/api/cowork/compose');

/** The server: what it makes of the sentence (per call, so an edit can be read differently), and a workspace with Fireflies and Gmail. */
function serve(spec: CoworkSpec | ((brief: string) => CoworkSpec), tiers = {}, catalog = { apps: [{ id: 'outlook', label: 'Outlook', available: true }], degraded: false }, allowed: string[] | null = null) {
    calls = stubRecordingFetch((call) => {
        const path = pathOf(call);
        if (path.endsWith('/agents/tool-catalog')) return jsonResponse(catalog);
        if (path.endsWith('/policy/mine')) return jsonResponse({ unattendedApps: allowed, readOnly: false });
        if (path === '/api/datatables') return jsonResponse({ datatables: [{ id: 't1', name: 'Incoming', grade: 'editor' }] });
        if (path.endsWith('/config/tiers-for-user')) return jsonResponse(tiers);
        if (path === '/api/cowork/compose') return jsonResponse(typeof spec === 'function' ? spec((call.body as { brief: string }).brief) : spec);
        if (path === '/api/cowork' && call.method === 'POST') return jsonResponse({ id: 'new', title: (call.body as { title: string }).title, runCount: 0 });
        if (path.endsWith('/ai/user-settings')) return jsonResponse({ hasFirefliesKey: true, isGoogleUser: true });
        return jsonResponse({});
    });
}
afterEach(() => { vi.unstubAllGlobals(); });

/** An organisation with fixed steps (automations), or without. */
const entitled = (steps: boolean): EntitlementsValue => ({
    loading: false, degraded: false, tier: 'full', mode: 'cloud', effective: { core: [], beta: [], integration: [] }, ceiling: { core: [], beta: [], integration: [] },
    can: (id) => steps && ['automations', 'datatables'].includes(id), inCeiling: () => true, lockReason: () => null, hasTier: () => true, reload: () => {},
});
const inOrg = (ui: ReactElement, steps = true) => <EntitlementsContext.Provider value={entitled(steps)}>{ui}</EntitlementsContext.Provider>;

function renderComposer({ steps = true, stepTypes = [] as string[], items = [] as CoworkItem[] } = {}) {
    const onCreated = vi.fn();
    const onTemplates = vi.fn();
    const onAskTask = vi.fn();
    renderWithClient(inOrg(<CoworkHomeComposer items={items} onAskTask={onAskTask} stepTypes={stepTypes} atLimit={false} maxItems={10} onTemplates={onTemplates} onCreated={onCreated} setup={null} />, steps));
    return { onCreated, onTemplates, onAskTask };
}

const box = () => screen.getByLabelText('Task instructions');

async function write(text: string, advanced = true) {
    const user = userEvent.setup();
    await user.type(box(), text);
    if (advanced && !screen.getByText('Advanced').closest('details')?.open) await user.click(screen.getByText('Advanced'));
    await user.click(screen.getByTestId('cowork-continue'));
    const card = await screen.findByTestId('cowork-confirm');
    const toggle = within(card).queryByRole('button', { name: 'Advanced', expanded: false });
    if (advanced && toggle) await user.click(toggle);
    return { user, card };
}

const WEEKLY: CoworkSpec = { title: 'Weekly meeting summary', prompt: 'Summarise last week’s meetings and mail the summary', repeatInterval: 'weekly', daysOfWeek: ['mon'], timeOfDay: '09:00' };

describe('CoworkHomeComposer', () => {
    const digest = { id: 'weekly-a', title: 'Weekoverzicht', prompt: 'Vat klantgesprekken samen', runCount: 1 };

    it.each(['Wijzig mijn weekoverzicht naar vrijdag', 'Kan je mijn Weekoverzicht aanpassen?'])('carries an explicit change into the named task with Ctrl+Enter: %s', async request => {
        serve(WEEKLY);
        const { onAskTask } = renderComposer({ items: [digest] });
        const user = userEvent.setup();
        await user.type(box(), request);
        expect(screen.getByRole('button', { name: 'Ask Bee about Weekoverzicht' })).toBeVisible();
        await user.keyboard('{Control>}{Enter}{/Control}');
        expect(onAskTask).toHaveBeenCalledWith(digest.id, request);
        expect(composed()).toHaveLength(0);
    });

    it('asks which identically scheduled task the owner means and distinguishes their instructions', async () => {
        serve(WEEKLY);
        const second = { ...digest, id: 'weekly-b', prompt: 'Vat leveranciersgesprekken samen' };
        const { onAskTask } = renderComposer({ items: [digest, second] });
        const user = userEvent.setup();
        const request = 'Pas mijn Weekoverzicht aan';
        await user.type(box(), request);
        await user.keyboard('{Control>}{Enter}{/Control}');
        expect(screen.getByRole('button', { name: 'Weekoverzicht Vat klantgesprekken samen' })).toHaveFocus();
        expect(onAskTask).not.toHaveBeenCalled();
        expect(composed()).toHaveLength(0);
        await user.click(screen.getByRole('button', { name: 'Weekoverzicht Vat leveranciersgesprekken samen' }));
        expect(onAskTask).toHaveBeenCalledWith(second.id, request);
    });

    it('lets the owner deliberately create a new task with the same name', async () => {
        serve(WEEKLY);
        const { onAskTask } = renderComposer({ items: [digest] });
        const user = userEvent.setup();
        await user.type(box(), 'Edit my Weekoverzicht');
        await user.click(screen.getByRole('button', { name: 'Create a new task' }));
        await waitFor(() => expect(created()).toBeDefined());
        expect(onAskTask).not.toHaveBeenCalled();
    });

    it('adds a selected Automations step to the existing task description', async () => {
        serve({});
        renderComposer({ stepTypes: ['condition'] });
        const user = userEvent.setup();
        await user.type(box(), 'Review my emails');
        await user.click(screen.getByText('Advanced'));
        await user.click(screen.getByText('Choose a step'));
        await user.click(screen.getByRole('button', { name: 'Condition' }));
        expect(box()).toHaveValue('Review my emails\nUse the Condition step.');
        expect(box()).toHaveFocus();
    });

    it('asks first, offers templates, and waits for a sentence', async () => {
        serve({});
        const { onTemplates } = renderComposer();
        expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('What should be done for you?');
        expect(screen.getByRole('button', { name: 'Set up and test' })).toBeDisabled();
        await userEvent.setup().click(screen.getByText('Start from a template'));
        await userEvent.setup().click(screen.getByRole('button', { name: 'All templates' }));
        expect(onTemplates).toHaveBeenCalled();
    });

    it('shows the model choice inline and saves the chosen tier on the new task', async () => {
        serve(WEEKLY, { auto: {}, pro: { modelId: 'deep-model' } });
        renderComposer();
        await userEvent.setup().click(screen.getByText('Advanced'));
        const picker = await screen.findByRole('combobox', { name: 'AI model' });
        const user = userEvent.setup();
        await user.selectOptions(picker, 'pro');
        expect(picker).toHaveDisplayValue('Deep Thinking · deep-model');
        const { card } = await write('Summarise the meetings every Monday at 09:00');
        await user.click(within(card).getByRole('button', { name: 'Set up and test' }));
        await waitFor(() => expect(created()?.body).toMatchObject({ modelTier: 'pro' }));
    });

    it('keeps Enter for a new paragraph and previews the task with Ctrl+Enter', async () => {
        serve(WEEKLY);
        renderComposer();
        const user = userEvent.setup();
        await user.type(box(), 'Lees de mail van sam@example.com.{Enter}Vat die samen in Cowork.');
        expect(box()).toHaveValue('Lees de mail van sam@example.com.\nVat die samen in Cowork.');
        expect(composed()).toHaveLength(0);
        await user.click(screen.getByText('Advanced'));
        await user.click(box());
        await user.keyboard('{Control>}{Enter}{/Control}');
        const card = await screen.findByTestId('cowork-confirm');
        expect(within(card).getByText('Available in this Cowork task')).toBeVisible();
        expect(within(card).queryByLabelText('Add an address')).toBeNull();
    });

    it('asks for the missing frequency, day and time under the orb before creating a task', async () => {
        serve({ title: 'Meeting overview', prompt: 'Summarise my meetings' });
        const { onCreated } = renderComposer();
        const { user, card } = await write('Summarise my meetings', false);
        expect(card.querySelector('.cowork-orb')).toBeVisible();
        const next = within(card).getByRole('button', { name: 'Set up and test' });
        expect(next).toBeDisabled();
        await user.selectOptions(within(card).getByLabelText('How often'), 'weekly');
        await user.selectOptions(within(card).getByLabelText('Which day?'), 'mon');
        expect(next).toBeDisabled();
        fireEvent.change(within(card).getByLabelText('At what time?'), { target: { value: '15:45' } });
        expect(created()).toBeUndefined();
        await user.dblClick(next);
        await waitFor(() => expect(onCreated).toHaveBeenCalledWith(expect.objectContaining({ id: 'new' })));
        expect(created()?.body).toMatchObject({ title: 'Meeting overview', repeatInterval: 'weekly', daysOfWeek: ['mon'], timeOfDay: '15:45', setup: { steps: true, sendsTo: [] } });
        expect((created()?.body as { startNow?: boolean }).startNow).toBeUndefined();
        expect(box()).toHaveValue('');
    });

    it('keeps the stated weekday and asks only for the missing time before setup', async () => {
        serve({ ...WEEKLY, timeOfDay: undefined });
        renderComposer();
        const { user, card } = await write('Every Monday, summarise my meetings', false);
        expect(card.querySelector('.cowork-orb')).toBeVisible();
        expect(within(card).queryByRole('combobox')).toBeNull();
        expect(created()).toBeUndefined();
        fireEvent.change(within(card).getByLabelText('At what time?'), { target: { value: '11:15' } });
        await user.click(within(card).getByRole('button', { name: 'Set up and test' }));
        await waitFor(() => expect(created()?.body).toMatchObject({ daysOfWeek: ['mon'], timeOfDay: '11:15' }));
    });

    it('a sentence that says when: no question, every row can be changed, and Cancel makes nothing', async () => {
        serve({ ...WEEKLY, delivery: { quote: 'send it to me', to: ['me'] } });
        renderComposer();
        const { user, card } = await write('Every Monday at 09:00, summarise last week’s meetings and send it to me');
        expect(within(card).queryByRole('combobox', { name: 'Which day?' })).toBeNull();
        expect(within(card).getByText(/Cowork sets up the steps and tests them once\. Nothing is sent during the test/)).toBeInTheDocument();
        expect(within(card).getByLabelText('At what time?')).toHaveValue('09:00');
        expect(within(screen.getByTestId('cowork-confirm-sends')).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['Me']);
        expect(within(card).queryByRole('switch')).toBeNull();
        expect(within(card).getByRole('button', { name: 'Set up and test' })).toBeEnabled();
        await user.click(within(card).getByRole('button', { name: 'Cancel' }));
        expect(screen.queryByTestId('cowork-confirm')).toBeNull();
        expect(created()).toBeUndefined();
    });

    it('"me and sam@…" shows both; "Me" can be taken off, an address added, and what is chosen goes with the task', async () => {
        serve({ ...WEEKLY, delivery: { quote: 'send it to me and sam@example.com', to: ['me', 'sam@example.com'] } });
        const { onCreated } = renderComposer();
        const { user, card } = await write('Every Monday at 09:00, summarise last week’s meetings and send it to me and sam@example.com');
        const sends = within(screen.getByTestId('cowork-confirm-sends'));
        expect(sends.getAllByRole('listitem').map((li) => li.textContent)).toEqual(['Me', 'sam@example.com']);
        expect(sends.getByRole('switch', { name: 'Show me each message first' })).toBeChecked();
        expect(softClasses(card)).toEqual([]);

        await user.type(sends.getByLabelText('Add an address'), 'not an address');
        await user.click(sends.getByRole('button', { name: 'Add' }));
        expect(sends.getByRole('alert')).toHaveTextContent('That is not an e-mail address.');
        await user.clear(sends.getByLabelText('Add an address'));
        await user.type(sends.getByLabelText('Add an address'), 'jo@example.com{Enter}');
        await user.click(sends.getByRole('button', { name: 'Remove Me' }));
        expect(sends.getAllByRole('listitem').map((li) => li.textContent)).toEqual(['sam@example.com', 'jo@example.com', 'Add me']);

        await user.click(within(card).getByRole('button', { name: 'Set up and test' }));
        await waitFor(() => expect(onCreated).toHaveBeenCalled());
        expect((created()?.body as { setup: unknown }).setup).toEqual({ steps: true, sendsTo: ['sam@example.com', 'jo@example.com'], askFirst: true });
        expect((created()?.body as { prompt: string }).prompt).toBe(WEEKLY.prompt);
    });

    it('"Show me each message first" can be switched off, and says what that means', async () => {
        serve({ ...WEEKLY, delivery: { quote: 'mail the summary to sam@example.com', to: ['sam@example.com'] } });
        const { onCreated } = renderComposer();
        const { user, card } = await write('Every Monday, mail the summary to sam@example.com');
        await user.click(within(card).getByRole('switch', { name: 'Show me each message first' }));
        expect(within(card).getByText(/Cowork still shows you each message at first/)).toBeInTheDocument();
        await user.click(within(card).getByRole('button', { name: 'Set up and test' }));
        await waitFor(() => expect(onCreated).toHaveBeenCalled());
        expect((created()?.body as { setup: { askFirst: boolean } }).setup.askFirst).toBe(false);
    });

    it('without fixed steps the card does not offer "Show me each message first": it says the AI sends by itself', async () => {
        serve({ ...WEEKLY, delivery: { quote: 'mail the summary to sam@example.com', to: ['sam@example.com'] } });
        const { onCreated } = renderComposer({ steps: false });
        const { user, card } = await write('Every Monday, mail the summary to sam@example.com');
        expect(within(card).queryByRole('switch', { name: 'Show me each message first' })).toBeNull();
        expect(within(card).getByTestId('cowork-confirm-sends-ai')).toHaveTextContent('The AI sends what it writes by itself.');
        await user.click(within(card).getByRole('button', { name: 'Start' }));
        await waitFor(() => expect(onCreated).toHaveBeenCalled());
        const setup = (created()?.body as { setup: { steps: boolean; sendsTo: string[] } }).setup;
        expect(setup).toMatchObject({ steps: false, sendsTo: expect.arrayContaining(['sam@example.com']) });
        expect(setup).not.toHaveProperty('askFirst');
    });

    it('Uses pre-selects only the apps the sentence names; apps can be added and taken off, and they are saved with the task', async () => {
        serve(WEEKLY);
        const { onCreated } = renderComposer();
        const { user, card } = await write('Every Monday, summarise my Fireflies meetings and send it to me');
        const uses = within(screen.getByTestId('cowork-confirm-uses'));
        await waitFor(() => expect(uses.getAllByRole('listitem').map((li) => li.textContent)).toEqual(['Fireflies.ai']));
        const add = uses.getByRole('combobox', { name: 'Add an app' });
        expect(within(add).getAllByRole('option').map((o) => o.textContent)).not.toContain('Fireflies.ai');
        await user.selectOptions(add, 'Gmail');
        expect(uses.getAllByRole('listitem').map((li) => li.textContent)).toEqual(['Fireflies.ai', 'Gmail']);
        await user.click(uses.getByRole('button', { name: 'Remove Fireflies.ai' }));
        await user.click(within(card).getByRole('button', { name: 'Set up and test' }));
        await waitFor(() => expect(onCreated).toHaveBeenCalled());
        expect((created()?.body as { enabledApps: string[] }).enabledApps).toEqual(['gmail']);
    });

    it('with every app taken off it says so: the AI only writes', async () => {
        serve(WEEKLY);
        const { onCreated } = renderComposer();
        const { user, card } = await write('Every Monday, summarise my Fireflies meetings');
        const uses = within(screen.getByTestId('cowork-confirm-uses'));
        await user.click(await uses.findByRole('button', { name: 'Remove Fireflies.ai' }));
        expect(uses.getByText('No apps. The AI only writes.')).toBeInTheDocument();
        expect(uses.getByRole('combobox', { name: 'Add an app' })).toBeInTheDocument();
        await user.click(within(card).getByRole('button', { name: 'Set up and test' }));
        await waitFor(() => expect(onCreated).toHaveBeenCalled());
        expect((created()?.body as { enabledApps: string[] }).enabledApps).toEqual([]);
    });

    it('editing the sentence keeps the card: it is read again, and what was changed by hand stays', async () => {
        const sending = { ...WEEKLY, delivery: { quote: 'send it to me and sam@example.com', to: ['me', 'sam@example.com'] } };
        serve((brief) => (brief.includes('Friday') ? { ...sending, title: 'Friday meeting summary', daysOfWeek: ['fri'], timeOfDay: '16:00' } : sending));
        const { onCreated } = renderComposer();
        const { user, card } = await write('Every Monday, summarise my meetings and send it to me and sam@example.com');
        // By hand: the name, and "Me" taken off.
        await user.clear(within(card).getByLabelText('Task name'));
        await user.type(within(card).getByLabelText('Task name'), 'Digest for Sam');
        await user.click(within(card).getByRole('button', { name: 'Remove Me' }));

        await user.click(screen.getByText('Edit task instructions'));
        await user.type(box(), ' and jo@example.com, on Friday');
        expect(screen.getByTestId('cowork-confirm')).toBeInTheDocument();
        await waitFor(() => expect(composed()).toHaveLength(2), { timeout: 4000 });
        expect((composed()[1]?.body as { brief: string }).brief).toContain('on Friday');
        await waitFor(() => expect(within(screen.getByTestId('cowork-confirm')).getByLabelText('At what time?')).toHaveValue('16:00'));
        const after = within(screen.getByTestId('cowork-confirm'));
        expect(after.getByLabelText('Task name')).toHaveValue('Digest for Sam');
        expect(within(screen.getByTestId('cowork-confirm-sends')).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['sam@example.com', 'Add me']);

        await waitFor(() => expect(after.getByRole('button', { name: 'Set up and test' })).toBeEnabled());
        await user.click(after.getByRole('button', { name: 'Set up and test' }));
        await waitFor(() => expect(onCreated).toHaveBeenCalled());
        expect(created()?.body).toMatchObject({ title: 'Digest for Sam', daysOfWeek: ['fri'], timeOfDay: '16:00', setup: { sendsTo: ['sam@example.com'] } });
    });

    it('an emptied box closes the card', async () => {
        serve(WEEKLY);
        renderComposer();
        const { user } = await write('Every Monday, summarise my meetings');
        await user.click(screen.getByText('Edit task instructions'));
        await user.clear(box());
        expect(screen.queryByTestId('cowork-confirm')).toBeNull();
    });

    it('where the organisation has no fixed steps the card says the AI works it out, and the task is started that way', async () => {
        serve(WEEKLY);
        const { onCreated } = renderComposer({ steps: false });
        const { user, card } = await write('Every Monday, summarise my meetings');
        expect(within(card).getByText('Your organisation has no fixed steps, so the AI works this task out on every run.')).toBeInTheDocument();
        await user.click(within(card).getByRole('button', { name: 'Start' }));
        await waitFor(() => expect(onCreated).toHaveBeenCalled());
        expect((created()?.body as { setup: { steps: boolean } }).setup.steps).toBe(false);
    });

    it('at the limit, it says so', () => {
        serve({});
        renderWithClient(inOrg(<CoworkHomeComposer atLimit maxItems={10} onTemplates={() => {}} onCreated={() => {}} setup={null} />));
        expect(screen.getByText('You have 10 tasks, the most you can have. Delete one to add another.')).toBeInTheDocument();
    });

    it('starts the held test from the brief in one action when no choice is needed', async () => {
        serve(WEEKLY);
        const { onCreated } = renderComposer();
        const user = userEvent.setup();
        await user.type(box(), 'Every Monday, summarise my meetings here');
        await user.click(screen.getByRole('button', { name: 'Set up and test' }));
        await waitFor(() => expect(onCreated).toHaveBeenCalledOnce());
        expect(created()?.body).toMatchObject({ setup: { steps: true, sendsTo: [] } });
        expect(screen.queryByTestId('cowork-confirm')).toBeNull();
        expect(composed()).toHaveLength(1);
    });

    it.each([true, false])('clarifies the goal before setup and reads only the actual answer (suggestion: %s)', async useSuggestion => {
        const initial = 'Help with my inbox';
        const suggested = 'Summarise unread mail';
        const custom = 'List flagged messages';
        const question = 'What would you like to do with your mail?';
        serve(brief => brief === initial
            ? { ...WEEKLY, clarification: { question, options: [suggested, 'Draft replies'] } }
            : { ...WEEKLY, prompt: brief });
        renderComposer();
        const { user, card } = await write(initial, false);
        expect(within(card).getByText(question)).toBeVisible();
        expect(created()).toBeUndefined();
        if (useSuggestion) {
            await user.click(within(card).getByRole('button', { name: suggested }));
        } else {
            await user.type(within(card).getByRole('textbox', { name: 'Your answer' }), custom);
            await user.click(within(card).getByRole('button', { name: 'Continue' }));
        }
        const completed = initial + '\n' + (useSuggestion ? suggested : custom);
        await waitFor(() => expect(created()?.body).toMatchObject({ prompt: completed, setup: { steps: true, sendsTo: [] } }));
        expect(composed().map(call => (call.body as { brief: string }).brief)).toEqual([initial, completed]);
    });

    it('asks the goal before a missing schedule and allows cancellation', async () => {
        serve({ clarification: { question: 'Which source should I summarise?', options: [] } });
        renderComposer();
        const { user, card } = await write('Make a summary', false);
        expect(within(card).getByText('Which source should I summarise?')).toBeVisible();
        expect(within(card).getByRole('button', { name: 'Continue' })).toBeDisabled();
        await user.click(within(card).getByRole('button', { name: 'Cancel' }));
        expect(created()).toBeUndefined();
        expect(box()).toHaveValue('Make a summary');
    });

    it.each([
        ['Send the summary to me', ['me']],
        ['Mail sam@example.com', ['sam@example.com']],
    ] as const)('starts a single held test for an explicit delivery: %s', async (quote, to) => {
        serve({ ...WEEKLY, delivery: { quote, to: [...to] } });
        const { onCreated } = renderComposer();
        const user = userEvent.setup();
        await user.type(box(), 'Every Monday at 09:00, summarise my Fireflies meetings. ' + quote);
        await user.dblClick(screen.getByRole('button', { name: 'Set up and test' }));
        await waitFor(() => expect(onCreated).toHaveBeenCalledOnce());
        expect(calls.filter(c => c.method === 'POST' && pathOf(c) === '/api/cowork')).toHaveLength(1);
        expect(created()?.body).toMatchObject({ setup: { steps: true, sendsTo: to } });
        expect(screen.queryByText('Review your task')).toBeNull();
    });

    it('uses a stated one-off date and asks only for the time', async () => {
        serve({ firstRunDate: '2099-04-16', oneOff: 'scheduled' });
        renderComposer();
        const { user, card } = await write('Summarise my meetings on April 16, 2099', false);
        expect(within(card).queryByRole('combobox')).toBeNull();
        expect(within(card).queryByLabelText('Date')).toBeNull();
        fireEvent.change(within(card).getByLabelText('At what time?'), { target: { value: '15:10' } });
        await user.click(within(card).getByRole('button', { name: 'Set up and test' }));
        await waitFor(() => expect(created()?.body).toMatchObject({ nextRunAt: new Date(2099, 3, 16, 15, 10).toISOString(), repeatInterval: null }));
    });

    it('keeps a live task behind an explicit start in the orb', async () => {
        serve(WEEKLY);
        renderComposer({ steps: false });
        const { user, card } = await write('Summarise my meetings every Monday at 09:00', false);
        expect(card.querySelector('.cowork-orb')).toBeVisible();
        expect(created()).toBeUndefined();
        await user.click(within(card).getByRole('button', { name: 'Start' }));
        await waitFor(() => expect(created()?.body).toMatchObject({ setup: { steps: false } }));
    });

    it('keeps a suggested morning time editable and cancels without creating a task', async () => {
        serve({ ...WEEKLY, repeatInterval: 'daily', daysOfWeek: [], timeOfDay: '08:00', timeIsSuggested: true });
        renderComposer();
        const { user, card } = await write('Every morning, summarise my meetings', false);
        expect(within(card).getByLabelText('At what time?')).toHaveValue('08:00');
        await user.click(within(card).getByRole('button', { name: 'Cancel' }));
        expect(box()).toHaveValue('Every morning, summarise my meetings');
        expect(created()).toBeUndefined();
    });

    it('uses the recipient answer and the schedule without another model call', async () => {
        serve({ ...WEEKLY, timeOfDay: undefined, delivery: { quote: 'email the summary', to: [] } });
        renderComposer();
        const { user, card } = await write('Every Monday email the summary', false);
        const recipient = within(card).getByLabelText('Who should receive the result?');
        await user.type(recipient, 'sam@example.com');
        await user.click(within(card).getByRole('button', { name: 'Continue' }));
        fireEvent.change(screen.getByLabelText('At what time?'), { target: { value: '10:30' } });
        await user.click(screen.getByRole('button', { name: 'Set up and test' }));
        await waitFor(() => expect(created()?.body).toMatchObject({ timeOfDay: '10:30', setup: { sendsTo: ['sam@example.com'], askFirst: true } }));
        expect(composed()).toHaveLength(1);
    });

    it('shows only the current setup phase and keeps creation controls out of the way', () => {
        serve({});
        renderWithClient(inOrg(<CoworkHomeComposer atLimit={false} maxItems={10} onTemplates={() => {}} onCreated={() => {}} setup={{ id: 'new', title: 'Meeting overview', phase: 'trying' }} />));
        expect(softClasses(screen.getByTestId('cowork-setup'))).toEqual([]);
        expect(screen.getByRole('status')).toHaveTextContent('I’m trying the steps once. Nothing is sent.');
        expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
        expect(screen.queryByText('Ready for your check')).not.toBeInTheDocument();
    });
});

it('reads the table answer and starts the held test directly', async () => {
    serve((brief) => ({ ...WEEKLY, ...(brief.includes('Orders') ? {} : { missingTarget: 'table' }) }));
    renderComposer();
    const { user, card } = await write('Every Monday add new rows to a table', false);
    expect(within(card).queryByTestId('cowork-confirm-start')).toBeNull();
    expect(card.querySelector('.cowork-orb')).toBeVisible();
    await user.type(within(card).getByLabelText('Which table should receive the rows?'), 'Orders');
    await user.click(within(card).getByRole('button', { name: 'Set up and test' }));
    await waitFor(() => expect(created()?.body).toMatchObject({ setup: { steps: true } }));
    expect(composed()).toHaveLength(2);
});

it('the file example asks for the folder and table in turn and leaves the result editable', async () => {
    serve(WEEKLY, {}, { apps: [{ id: 'nextcloud', label: 'Nextcloud', available: true }], degraded: false });
    renderComposer();
    const user = userEvent.setup();
    await user.click(screen.getByText('Start from a template'));
    await user.click(await screen.findByRole('button', { name: 'Register Nextcloud files' }));
    await user.type(screen.getByLabelText('Which Nextcloud folder should Cowork check?'), '/Intake');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await user.click(await screen.findByRole('button', { name: 'Incoming' }));
    expect((box() as HTMLTextAreaElement).value).toContain('folder /Intake');
    expect((box() as HTMLTextAreaElement).value).toContain('table Incoming');
    expect(composed()).toHaveLength(0);
});


it('offers only connected and permitted integrations and skips the mail app question for Outlook alone', async () => {
    const apps = [
        { id: 'outlook', label: 'Outlook', available: true },
        { id: 'nextcloud', label: 'Nextcloud', available: false },
        { id: 'fireflies', label: 'Fireflies', available: true },
    ];
    serve(WEEKLY, {}, { apps, degraded: false }, ['outlook', 'nextcloud']);
    renderComposer();
    const user = userEvent.setup();
    await user.click(screen.getByText('Start from a template'));
    const mail = await screen.findByRole('button', { name: 'Draft supplier replies' });
    for (const name of ['Weekly Fireflies summary', 'Register Nextcloud files', 'Report exceptions in a table']) {
        expect(screen.queryByRole('button', { name })).toBeNull();
    }
    await user.click(mail);
    await user.type(screen.getByRole('textbox', {name: 'Which supplier email address should it look for?'}), 'supplier@example.com');
    await user.click(screen.getByRole('button', {name: 'Continue'}));
    expect((box() as HTMLTextAreaElement).value).toContain('Outlook');
});

it('keeps external templates hidden if the catalog could not verify connections', async () => {
    serve(WEEKLY, {}, { apps: [{ id: 'fireflies', label: 'Fireflies', available: true }], degraded: true });
    renderComposer();
    await userEvent.setup().click(screen.getByText('Start from a template'));
    expect(await screen.findByRole('button', { name: 'Report exceptions in a table' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Weekly Fireflies summary' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Draft supplier replies' })).toBeNull();
});
