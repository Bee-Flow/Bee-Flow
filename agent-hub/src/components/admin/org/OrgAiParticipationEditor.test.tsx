// The organisation's switch for the AI that joins by itself: loading, a load
// that failed (never shown as the defaults), a save that sends the whole
// policy, a refused save, and the rest locked while the switch is off.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { beforeEach, expect, it, vi } from 'vitest';
import OrgAiParticipationEditor from './OrgAiParticipationEditor';

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));
vi.mock('../../../utils/helpers', () => ({ API_BASE: '', authFetch: fetchMock }));

const POLICY = {
    autoAllowed: true, alwaysAllowed: true, commentsAutoAllowed: true, sensitivity: 'balanced',
    cooldownMinutes: 3, maxAutoPerChatHour: 4, maxAutoPerProjectDay: 30, maxGatesPerChatHour: 12, maxGatesPerOrgDay: 500,
    quietSeconds: 45, maxDebounceSeconds: 180, unansweredMinutes: 10, commentUnansweredMinutes: 30,
    configured: false, ranges: { cooldownMinutes: [1, 240], maxAutoPerChatHour: [1, 30], maxAutoPerProjectDay: [1, 500], unansweredMinutes: [2, 1440] },
    sensitivities: ['conservative', 'balanced', 'eager'],
};

const respond = (status: number, body: unknown) => ({
    ok: status < 400, status, headers: { get: () => 'application/json' }, json: async () => body,
});
let puts: unknown[];
let getStatus: number;
let putStatus: number;

beforeEach(() => {
    puts = [];
    getStatus = 200;
    putStatus = 200;
    fetchMock.mockReset();
    fetchMock.mockImplementation(async (url: string, init: RequestInit = {}) => {
        if (!String(url).includes('/api/ai-participation/org/org1')) return respond(404, { error: 'Not found' });
        if ((init.method || 'GET') === 'PUT') {
            const body = JSON.parse(String(init.body));
            puts.push(body);
            return putStatus === 200 ? respond(200, { ...POLICY, ...body, configured: true }) : respond(putStatus, { error: 'Only an admin of this organisation can change how the AI takes part.' });
        }
        return getStatus === 200 ? respond(200, POLICY) : respond(getStatus, { error: 'The AI participation settings could not be read.' });
    });
});

function renderEditor(orgId: string | null = 'org1', enabled?: boolean) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    return render(<QueryClientProvider client={client}><OrgAiParticipationEditor orgId={orgId} enabled={enabled} /></QueryClientProvider>);
}

it('shows the current policy, and saves the whole of it', async () => {
    const user = userEvent.setup();
    renderEditor();
    const master = await screen.findByRole('checkbox', { name: /Let the AI join conversations by itself/ });
    expect(master).toBeChecked();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();

    await user.click(screen.getByRole('radio', { name: /Reserved/ }));
    const cooldown = screen.getByLabelText('Quiet time after an answer (minutes)');
    await user.clear(cooldown);
    await user.type(cooldown, '15');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]).toMatchObject({ autoAllowed: true, alwaysAllowed: true, commentsAutoAllowed: true, sensitivity: 'conservative', cooldownMinutes: 15, maxGatesPerOrgDay: 500 });
    expect(puts[0]).not.toHaveProperty('configured');
    expect(puts[0]).not.toHaveProperty('ranges');
    expect(await screen.findByText('Saved. It applies to the next message.')).toBeInTheDocument();
});

it('with the switch off, the rest is locked', async () => {
    const user = userEvent.setup();
    renderEditor();
    await user.click(await screen.findByRole('checkbox', { name: /Let the AI join conversations by itself/ }));
    expect(screen.getByRole('checkbox', { name: /Also in comment threads/ })).toBeDisabled();
    expect(screen.getByLabelText('Answers per chat, per hour')).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(puts[0]).toMatchObject({ autoAllowed: false }));
});

it('a refused save says so and keeps the change on screen', async () => {
    putStatus = 403;
    const user = userEvent.setup();
    renderEditor();
    await user.click(await screen.findByRole('checkbox', { name: /Allow "Always"/ }));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not save these settings. Try again.');
    expect(screen.getByRole('checkbox', { name: /Allow "Always"/ })).not.toBeChecked();
});

it('a load that failed is said, never shown as the defaults', async () => {
    getStatus = 503;
    renderEditor();
    expect(await screen.findByText('Could not load these settings.')).toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
});

it('renders nothing without an organisation', () => {
    const { container } = renderEditor(null);
    expect(container).toBeEmptyDOMElement();
    expect(fetchMock).not.toHaveBeenCalled();
});

it('where Projects cannot be used (plan or operator switch), shows nothing and asks nothing', async () => {
    // The setting acts only inside projects: an admin without them is not
    // offered a switch for something nobody in the organisation can use.
    const { container } = renderEditor('org1', false);
    expect(container).toBeEmptyDOMElement();
    await new Promise((r) => setTimeout(r, 0));
    expect(fetchMock).not.toHaveBeenCalled();
});
