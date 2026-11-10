import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithClient } from '@/test/render';
import SupportConnectionsConfig from './SupportConnectionsConfig';

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const fetchMock = vi.fn();

beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
        const u = String(url);
        if (u.includes('/youtrack/status')) return json({ configured: true, ok: true, host: 'yt.example', defaultProject: 'BF', projects: [{ id: '1', shortName: 'BF', name: 'Bee Flow' }] });
        if (u.includes('/youtrack/connection')) return json({ status: { configured: true, ok: true, host: 'yt.example', projects: [] } });
        if (u.endsWith('/notifications') && !init?.method) return json({ configured: true, enabled: false, host: 'chat.example', provider: 'slack', events: ['ticket_created'], availableEvents: ['ticket_created', 'sla_breach'] });
        return json({});
    });
    vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe('SupportConnectionsConfig', () => {
    it('shows both connections with labelled fields and their state', async () => {
        renderWithClient(<SupportConnectionsConfig />);
        expect(await screen.findByText('Connected to yt.example. 1 projects visible.')).toBeInTheDocument();
        expect(screen.getByText('Webhook saved for chat.example. Notifications are off.')).toBeInTheDocument();
        expect(screen.getByRole('textbox', { name: 'Server URL' })).toHaveAttribute('placeholder', 'https://yt.example');
        expect(screen.getByRole('combobox', { name: 'Default project' })).toHaveValue('BF');
        expect(screen.getByRole('combobox', { name: 'Where to send it' })).toHaveValue('slack');
        expect(screen.getByRole('checkbox', { name: 'A new ticket arrives' })).toBeChecked();
        expect(screen.getByRole('checkbox', { name: 'An SLA is breached' })).not.toBeChecked();
        expect(screen.getByRole('button', { name: 'Turn notifications on' })).toBeEnabled();
    });

    it('saves the YouTrack connection with the chosen project', async () => {
        renderWithClient(<SupportConnectionsConfig />);
        await screen.findByText('Connected to yt.example. 1 projects visible.');
        await userEvent.click(screen.getByRole('button', { name: 'Save connection' }));
        await waitFor(() => expect(fetchMock.mock.calls.some(([u]) => String(u).includes('/youtrack/connection'))).toBe(true));
        const [, init] = fetchMock.mock.calls.find(([u]) => String(u).includes('/youtrack/connection'))!;
        expect(init.method).toBe('PUT');
        expect(JSON.parse(String(init.body))).toEqual({ project: 'BF', includeSubject: false });
    });
});
