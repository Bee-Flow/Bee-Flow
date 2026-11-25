// The composer of the Cowork home and its ONE confirmation card (./CoworkHomeComposer.tsx, ./CoworkConfirmCard.tsx):
// "Show what I understood" works the sentence out, the card says What, When, Uses and Sends to and lets each be
// changed, an edit of the sentence updates the card without losing what was changed by hand, and "Set up and test"
// creates the task with what the card shows. The network is the seam (a recording fetch).
import type { ReactElement } from 'react';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithClient } from '@/test/render';
import { jsonResponse, stubRecordingFetch, type RecordedCall } from '@/test/recordingFetch';
import CoworkHomeComposer from './CoworkHomeComposer';
import { softClasses } from './crisp.testkit';
import EntitlementsContext, { type EntitlementsValue } from '../licensing/EntitlementsContext';
import type { CoworkSpec } from '@/api/cowork.types';

let calls: RecordedCall[];
const pathOf = (call: RecordedCall): string => new URL(call.url, 'http://x').pathname;
const created = (): RecordedCall | undefined => calls.find((c) => c.method === 'POST' && pathOf(c) === '/api/cowork');
const composed = (): RecordedCall[] => calls.filter((c) => pathOf(c) === '/api/cowork/compose');

/** The server: what it makes of the sentence (per call, so an edit can be read differently), and a workspace with Fireflies and Gmail. */
function serve(spec: CoworkSpec | ((brief: string) => CoworkSpec)) {
    calls = stubRecordingFetch((call) => {
        const path = pathOf(call);
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
    can: (id) => steps && id === 'automations', inCeiling: () => true, lockReason: () => null, hasTier: () => true, reload: () => {},
});
const inOrg = (ui: ReactElement, steps = true) => <EntitlementsContext.Provider value={entitled(steps)}>{ui}</EntitlementsContext.Provider>;

function renderComposer({ steps = true } = {}) {
    const onCreated = vi.fn();
    const onTemplates = vi.fn();
    renderWithClient(inOrg(<CoworkHomeComposer atLimit={false} maxItems={10} onTemplates={onTemplates} onCreated={onCreated} setup={null} />, steps));
    return { onCreated, onTemplates };
}

const box = () => screen.getByLabelText('Describe the task in one sentence');

async function write(text: string) {
    const user = userEvent.setup();
    await user.type(box(), text);
    await user.click(screen.getByRole('button', { name: 'Show what I understood' }));
    return { user, card: await screen.findByTestId('cowork-confirm') };
}

const WEEKLY: CoworkSpec = { title: 'Weekly meeting summary', prompt: 'Summarise last week’s meetings and mail the summary', repeatInterval: 'weekly', daysOfWeek: ['mon'], timeOfDay: '09:00' };

describe('CoworkHomeComposer', () => {
    it('asks first, offers templates, and waits for a sentence', async () => {
        serve({});
        const { onTemplates } = renderComposer();
        expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('What should be done for you?');
        expect(screen.getByRole('button', { name: 'Show what I understood' })).toBeDisabled();
        await userEvent.setup().click(screen.getByRole('button', { name: 'Start from a template' }));
        expect(onTemplates).toHaveBeenCalled();
    });

    it('a sentence without a day: the card asks "Which day?", and "Set up and test" waits for the answer', async () => {
        serve({ title: 'Meeting overview', prompt: 'Summarise my meetings' });
        const { onCreated } = renderComposer();
        const { user, card } = await write('Summarise my meetings');
        expect(within(card).getByLabelText('What')).toHaveValue('Meeting overview');
        expect(within(card).getByText('Your sentence does not say when. Pick a day and it is ready to start.')).toBeInTheDocument();
        expect(within(card).getByRole('button', { name: 'Set up and test' })).toBeDisabled();
        const days = within(card).getByRole('combobox', { name: 'Which day?' });
        const monday = within(days).getAllByRole('option').find((o) => (o as HTMLOptionElement).value === 'mon') as HTMLOptionElement;
        await user.selectOptions(days, monday);
        expect(within(card).queryByRole('combobox', { name: 'Which day?' })).toBeNull();
        expect(screen.getByTestId('cowork-confirm-when')).toHaveTextContent(/Every .+ at/);
        await user.click(within(card).getByRole('button', { name: 'Set up and test' }));
        await waitFor(() => expect(onCreated).toHaveBeenCalledWith(expect.objectContaining({ id: 'new' })));
        expect(created()?.body).toMatchObject({ title: 'Meeting overview', repeatInterval: 'weekly', daysOfWeek: ['mon'], timeOfDay: '09:00', setup: { steps: true, sendsTo: ['me'] } });
        expect((created()?.body as { startNow?: boolean }).startNow).toBeUndefined();
        expect(box()).toHaveValue('');
    });

    it('a sentence that says when: no question, every row can be changed, and Cancel makes nothing', async () => {
        serve(WEEKLY);
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
        serve(WEEKLY);
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
        serve(WEEKLY);
        const { onCreated } = renderComposer();
        const { user, card } = await write('Every Monday, mail the summary to sam@example.com');
        await user.click(within(card).getByRole('switch', { name: 'Show me each message first' }));
        expect(within(card).getByText(/Cowork still shows you each message at first/)).toBeInTheDocument();
        await user.click(within(card).getByRole('button', { name: 'Set up and test' }));
        await waitFor(() => expect(onCreated).toHaveBeenCalled());
        expect((created()?.body as { setup: { askFirst: boolean } }).setup.askFirst).toBe(false);
    });

    it('without fixed steps the card does not offer "Show me each message first": it says the AI sends by itself', async () => {
        serve(WEEKLY);
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
        serve((brief) => (brief.includes('Friday') ? { ...WEEKLY, title: 'Friday meeting summary', daysOfWeek: ['fri'], timeOfDay: '16:00' } : WEEKLY));
        const { onCreated } = renderComposer();
        const { user, card } = await write('Every Monday, summarise my meetings and send it to me and sam@example.com');
        // By hand: the name, and "Me" taken off.
        await user.clear(within(card).getByLabelText('What'));
        await user.type(within(card).getByLabelText('What'), 'Digest for Sam');
        await user.click(within(card).getByRole('button', { name: 'Remove Me' }));

        await user.type(box(), ' and jo@example.com, on Friday');
        expect(screen.getByTestId('cowork-confirm')).toBeInTheDocument();
        await waitFor(() => expect(composed()).toHaveLength(2), { timeout: 4000 });
        expect((composed()[1]?.body as { brief: string }).brief).toContain('on Friday');
        await waitFor(() => expect(within(screen.getByTestId('cowork-confirm')).getByLabelText('At what time?')).toHaveValue('16:00'));
        const after = within(screen.getByTestId('cowork-confirm'));
        expect(after.getByLabelText('What')).toHaveValue('Digest for Sam');
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

    it('shows the set-up of a new task as phases', () => {
        serve({});
        renderWithClient(inOrg(<CoworkHomeComposer atLimit={false} maxItems={10} onTemplates={() => {}} onCreated={() => {}} setup={{ id: 'new', title: 'Meeting overview', phase: 1 }} />));
        expect(softClasses(screen.getByTestId('cowork-setup'))).toEqual([]);
        const steps = within(screen.getByTestId('cowork-setup')).getAllByRole('listitem');
        expect(steps.map((s) => [s.textContent, s.dataset.state])).toEqual([
            ['Setting up the steps', 'did'], ['Testing once, nothing is sent', 'now'], ['Ready for your check', 'next'],
        ]);
    });
});
