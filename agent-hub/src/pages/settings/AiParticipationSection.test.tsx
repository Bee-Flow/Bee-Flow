// One's own opt-out from the AI joining team chats by itself: read, changed
// at once, put back when the server refuses, a failed read that says so, and
// hidden on a server that does not have the feature.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { beforeEach, expect, it, vi } from 'vitest';
import AiParticipationSection from './AiParticipationSection';

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));
vi.mock('../../utils/helpers', () => ({ API_BASE: '', authFetch: fetchMock }));

const respond = (status: number, body: unknown) => ({
    ok: status < 400, status, headers: { get: () => 'application/json' }, json: async () => body,
});
let stored: boolean;
let getStatus: number;
let putStatus: number;
let puts: unknown[];

beforeEach(() => {
    stored = true;
    getStatus = 200;
    putStatus = 200;
    puts = [];
    fetchMock.mockReset();
    fetchMock.mockImplementation(async (url: string, init: RequestInit = {}) => {
        if (!String(url).endsWith('/api/ai-participation/me')) return respond(404, {});
        if ((init.method || 'GET') === 'PUT') {
            const body = JSON.parse(String(init.body));
            puts.push(body);
            if (putStatus !== 200) return respond(putStatus, { error: 'Nope' });
            stored = body.autoJoinOnMyMessages;
            return respond(200, { autoJoinOnMyMessages: stored });
        }
        return getStatus === 200 ? respond(200, { autoJoinOnMyMessages: stored }) : respond(getStatus, { error: 'Could not be read.' });
    });
});

function renderSection(enabled?: boolean) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    return render(<QueryClientProvider client={client}><AiParticipationSection enabled={enabled} /></QueryClientProvider>);
}

const SWITCH = { name: 'Let the AI join in after my messages' };

it('is on by default and turns off with one click', async () => {
    const user = userEvent.setup();
    renderSection();
    const toggle = await screen.findByRole('switch', SWITCH);
    await waitFor(() => expect(toggle).toBeEnabled());
    expect(toggle).toHaveAttribute('aria-checked', 'true');
    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    await waitFor(() => expect(puts).toEqual([{ autoJoinOnMyMessages: false }]));
});

it('a refused save puts the switch back and says so', async () => {
    putStatus = 500;
    const user = userEvent.setup();
    renderSection();
    const toggle = await screen.findByRole('switch', SWITCH);
    await waitFor(() => expect(toggle).toBeEnabled());
    await user.click(toggle);
    expect(await screen.findByText('Could not save this setting. Try again.')).toBeInTheDocument();
    expect(toggle).toHaveAttribute('aria-checked', 'true');
});

it('a failed read says so and cannot be toggled', async () => {
    getStatus = 503;
    renderSection();
    expect(await screen.findByText(/Could not load this setting\./)).toBeInTheDocument();
    expect(screen.getByRole('switch', SWITCH)).toBeDisabled();
});

it('hides itself on a server without the feature', async () => {
    getStatus = 404;
    const { container } = renderSection();
    await waitFor(() => expect(container).toBeEmptyDOMElement());
});

it('is not shown, and not read, where Projects cannot be used', async () => {
    // The server answers this setting on every install (200, never 404), so
    // "Projects off" is the host's to say, not a 404's.
    const { container } = renderSection(false);
    expect(container).toBeEmptyDOMElement();
    await new Promise((r) => setTimeout(r, 0));
    expect(fetchMock).not.toHaveBeenCalled();
});
