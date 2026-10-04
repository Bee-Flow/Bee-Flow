// Settings → Integrations → Microsoft 365: the tile that lets a Google-SSO or
// password user connect Outlook. It reads the connector status, opens the
// consent popup, re-reads after a successful callback, and disconnects.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import Microsoft365Integration, { Microsoft365Group } from './Microsoft365Integration';

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));
vi.mock('../../utils/helpers', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../../utils/helpers')>()),
    API_BASE: '',
    authFetch: fetchMock,
}));

const respond = (status: number, body: unknown) => ({
    ok: status < 400, status, headers: { get: () => 'application/json' }, json: async () => body,
});

let status: Record<string, unknown>;
let disconnects: number;

beforeEach(() => {
    status = { configured: true, connected: false, needsReauth: false, email: null };
    disconnects = 0;
    fetchMock.mockReset();
    fetchMock.mockImplementation(async (url: string, init: RequestInit = {}) => {
        const path = String(url);
        if (path.endsWith('/api/integrations/microsoft/status')) return respond(200, status);
        if (path.endsWith('/api/integrations/microsoft/auth-url')) return respond(200, { url: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize?x=1' });
        if (path.endsWith('/api/integrations/microsoft/disconnect') && init.method === 'POST') {
            disconnects += 1;
            status = { configured: true, connected: false, needsReauth: false, email: null };
            return respond(200, { success: true });
        }
        return respond(404, {});
    });
});

afterEach(() => { vi.restoreAllMocks(); });

function renderTile(onSaved = vi.fn()) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    render(<QueryClientProvider client={client}><Microsoft365Integration onSaved={onSaved} last /></QueryClientProvider>);
    return onSaved;
}

async function expand(user: ReturnType<typeof userEvent.setup>) {
    await user.click(screen.getByText('Microsoft 365'));
}

it('connects through the popup and shows the account after the callback', async () => {
    const user = userEvent.setup();
    const open = vi.spyOn(window, 'open').mockReturnValue({ closed: false } as Window);
    const onSaved = renderTile();
    await screen.findByText('Connect Outlook so AI tools and automations can read and send your Microsoft 365 mail');
    await expand(user);
    await user.click(screen.getByRole('button', { name: 'Connect Microsoft 365' }));

    await waitFor(() => expect(open).toHaveBeenCalled());
    expect(open.mock.calls[0][0]).toBe('https://login.microsoftonline.com/common/oauth2/v2.0/authorize?x=1');
    expect(open.mock.calls[0][1]).toBe('microsoft-oauth');

    status = { configured: true, connected: true, email: 'anna@example.com' };
    window.dispatchEvent(new MessageEvent('message', {
        data: { type: 'microsoft-callback', success: true },
        origin: window.location.origin,
    }));

    expect(await screen.findByText('Connected as anna@example.com — Outlook works in chat and automations')).toBeTruthy();
    expect(onSaved).toHaveBeenCalledTimes(1);
});

it('ignores a callback message from a foreign origin', async () => {
    const user = userEvent.setup();
    vi.spyOn(window, 'open').mockReturnValue({ closed: false } as Window);
    const onSaved = renderTile();
    await screen.findByText('Connect Outlook so AI tools and automations can read and send your Microsoft 365 mail');
    await expand(user);
    await user.click(screen.getByRole('button', { name: 'Connect Microsoft 365' }));
    await waitFor(() => expect(window.open).toHaveBeenCalled());

    window.dispatchEvent(new MessageEvent('message', {
        data: { type: 'microsoft-callback', success: true },
        origin: 'https://evil.example',
    }));
    await new Promise((r) => setTimeout(r, 20));
    expect(onSaved).not.toHaveBeenCalled();
});

it('says so when the admin has not configured Microsoft', async () => {
    status = { configured: false, connected: false };
    const user = userEvent.setup();
    renderTile();
    await screen.findByText('Connect Outlook so AI tools and automations can read and send your Microsoft 365 mail');
    await expand(user);
    expect(screen.getByText(/Microsoft 365 is not configured/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Connect Microsoft 365' })).toBeNull();
});

it('disconnects a connected account', async () => {
    status = { configured: true, connected: true, email: 'anna@example.com' };
    const user = userEvent.setup();
    const onSaved = renderTile();
    await screen.findByText('Connected as anna@example.com — Outlook works in chat and automations');
    await expand(user);
    await user.click(screen.getByRole('button', { name: /Disconnect/ }));

    await waitFor(() => expect(disconnects).toBe(1));
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(await screen.findByRole('button', { name: 'Connect Microsoft 365' })).toBeTruthy();
});

it('hides Disconnect for a Microsoft-SSO connection, which it would break', async () => {
    status = { configured: true, connected: true, viaSso: true, email: 'anna@example.com' };
    const user = userEvent.setup();
    renderTile();
    await screen.findByText('Connected as anna@example.com — Outlook works in chat and automations');
    await expand(user);
    expect(screen.getByText('Connected through your Microsoft sign-in. Sign out to end it.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Disconnect/ })).toBeNull();
});

it('offers Reconnect when the grant expired', async () => {
    status = { configured: true, connected: false, needsReauth: true, email: 'anna@example.com' };
    const user = userEvent.setup();
    renderTile();
    await screen.findByText('Your Microsoft connection expired — reconnect to keep tools and automations working');
    await expand(user);
    expect(screen.getByRole('button', { name: 'Reconnect' })).toBeTruthy();
});

it('the group shows only when a Microsoft app is in the effective set', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { rerender } = render(
        <QueryClientProvider client={client}><Microsoft365Group isEnabled={(id) => id === 'gmail'} onSaved={vi.fn()} /></QueryClientProvider>,
    );
    expect(screen.queryByText('Microsoft 365')).toBeNull();

    rerender(<QueryClientProvider client={client}><Microsoft365Group isEnabled={(id) => id === 'outlook'} onSaved={vi.fn()} /></QueryClientProvider>);
    expect(await screen.findAllByText('Microsoft 365')).toHaveLength(2); // group label + row name
});
