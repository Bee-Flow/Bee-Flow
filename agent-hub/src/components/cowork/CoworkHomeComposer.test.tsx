// The composer of the Cowork home and its ONE confirmation card (./CoworkHomeComposer.tsx, ./CoworkConfirmCard.tsx):
// "Show what I understood" works the sentence out, the card says When, Uses and Sends to, asks "Which day?" when the sentence did not
// say, and Start creates the task with what the card shows. The network is the seam (a recording fetch).
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithClient } from '@/test/render';
import { jsonResponse, stubRecordingFetch, type RecordedCall } from '@/test/recordingFetch';
import CoworkHomeComposer from './CoworkHomeComposer';
import type { CoworkSpec } from '@/api/cowork.types';

let calls: RecordedCall[];
function serve(spec: CoworkSpec) {
    calls = stubRecordingFetch(({ url, method }) => {
        const path = new URL(url, 'http://x').pathname;
        if (path === '/api/cowork/compose') return jsonResponse(spec);
        if (path === '/api/cowork' && method === 'POST') return jsonResponse({ id: 'new', title: spec.title, prompt: spec.prompt, runCount: 0 });
        return jsonResponse({});
    });
}
afterEach(() => { vi.unstubAllGlobals(); });

function renderComposer() {
    const onCreated = vi.fn();
    const onTemplates = vi.fn();
    renderWithClient(<CoworkHomeComposer atLimit={false} maxItems={10} onTemplates={onTemplates} onCreated={onCreated} setup={null} />);
    return { onCreated, onTemplates };
}

async function write(text: string) {
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Describe the task in one sentence'), text);
    await user.click(screen.getByRole('button', { name: 'Show what I understood' }));
    return { user, card: await screen.findByTestId('cowork-confirm') };
}

describe('CoworkHomeComposer', () => {
    it('asks first, offers templates, and "Show what I understood" waits for a sentence', async () => {
        serve({});
        const { onTemplates } = renderComposer();
        expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('What should be done for you?');
        expect(screen.getByRole('button', { name: 'Show what I understood' })).toBeDisabled();
        await userEvent.setup().click(screen.getByRole('button', { name: 'Start from a template' }));
        expect(onTemplates).toHaveBeenCalled();
    });

    it('a sentence without a day: the card asks "Which day?", and Start waits for the answer', async () => {
        serve({ title: 'Meeting overview', prompt: 'Summarise my meetings' });
        const { onCreated } = renderComposer();
        const { user, card } = await write('Summarise my meetings');
        expect(within(card).getByRole('heading', { name: 'Meeting overview' })).toBeInTheDocument();
        expect(within(card).getByText('Your sentence does not say when. Pick a day and it is ready to start.')).toBeInTheDocument();
        expect(within(card).getByRole('button', { name: 'Start' })).toBeDisabled();
        const days = within(card).getByRole('combobox', { name: 'Which day?' });
        const monday = within(days).getAllByRole('option').find((o) => (o as HTMLOptionElement).value === 'mon') as HTMLOptionElement;
        await user.selectOptions(days, monday);
        expect(within(card).queryByRole('combobox', { name: 'Which day?' })).toBeNull();
        expect(screen.getByTestId('cowork-confirm-when')).toHaveTextContent(/Every .+ at/);
        await user.click(within(card).getByRole('button', { name: 'Start' }));
        await waitFor(() => expect(onCreated).toHaveBeenCalledWith(expect.objectContaining({ id: 'new' })));
        const created = calls.find((c) => c.method === 'POST' && new URL(c.url, 'http://x').pathname === '/api/cowork');
        expect(created?.body).toMatchObject({ title: 'Meeting overview', repeatInterval: 'weekly', daysOfWeek: ['mon'], timeOfDay: '09:00' });
        expect((created?.body as { startNow?: boolean }).startNow).toBeUndefined();
        expect(screen.getByLabelText('Describe the task in one sentence')).toHaveValue('');
    });

    it('a sentence that says when: no question, the time can be changed, and it sends only to its owner', async () => {
        serve({ title: 'Team meeting overview', prompt: 'Summarise last week’s meetings and send it to me', repeatInterval: 'weekly', daysOfWeek: ['mon'], timeOfDay: '09:00' });
        renderComposer();
        const { user, card } = await write('Every Monday at 09:00, summarise last week’s meetings and send it to me');
        expect(within(card).queryByRole('combobox', { name: 'Which day?' })).toBeNull();
        expect(within(card).getByText('After you start, Cowork sets up the steps and tests them once. Nothing is sent during the test.')).toBeInTheDocument();
        expect(within(card).getByLabelText('At what time?')).toHaveValue('09:00');
        expect(screen.getByTestId('cowork-confirm-sends')).toHaveTextContent('Only you');
        expect(within(card).getByRole('button', { name: 'Start' })).toBeEnabled();
        await user.click(within(card).getByRole('button', { name: 'Cancel' }));
        expect(screen.queryByTestId('cowork-confirm')).toBeNull();
        expect(calls.some((c) => c.method === 'POST' && new URL(c.url, 'http://x').pathname === '/api/cowork')).toBe(false);
    });

    it('at the limit, it says so and offers no "Show what I understood"', () => {
        serve({});
        renderWithClient(<CoworkHomeComposer atLimit maxItems={10} onTemplates={() => {}} onCreated={() => {}} setup={null} />);
        expect(screen.getByText('You have 10 tasks, the most you can have. Delete one to add another.')).toBeInTheDocument();
    });

    it('shows the set-up of a new task as phases', () => {
        serve({});
        renderWithClient(<CoworkHomeComposer atLimit={false} maxItems={10} onTemplates={() => {}} onCreated={() => {}} setup={{ id: 'new', title: 'Meeting overview', phase: 1 }} />);
        const steps = within(screen.getByTestId('cowork-setup')).getAllByRole('listitem');
        expect(steps.map((s) => [s.textContent, s.dataset.state])).toEqual([
            ['Setting up the steps', 'did'], ['Testing once, nothing is sent', 'now'], ['Ready for your check', 'next'],
        ]);
    });
});
