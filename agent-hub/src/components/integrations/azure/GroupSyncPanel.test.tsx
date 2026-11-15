/**
 * The Entra ID group sync of an organisation (GroupSyncPanel, a card of the
 * Microsoft 365 page): it reads the organisation-scoped status route, shows the
 * last run, "Sync now" and the sync settings, says the directory connection is
 * the platform administrator's, and shows no field of that connection.
 */
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithClient } from '@/test/render';
import GroupSyncPanel from './GroupSyncPanel';

const fetchMock = vi.fn();
const json = (body: unknown, status = 200) => ({
    ok: status >= 200 && status < 300, status,
    json: async () => body, text: async () => JSON.stringify(body),
    headers: new Headers({ 'content-type': 'application/json' }),
});
const calls = () => fetchMock.mock.calls.map(([url, init]) => `${(init as RequestInit | undefined)?.method || 'GET'} ${new URL(String(url), 'http://x').pathname}`);

const STATUS = '/api/org-azure-config/org1/sync-groups/status';
const READ = (directoryConfigured: boolean) => ({
    directoryConfigured,
    status: { lastSyncAt: null, lastSyncResult: null, syncedGroups: 0, syncedUsers: 0, errorCount: 0 },
    settings: { destructiveSync: false, autoActivateUsers: true, periodicSync: false, syncIntervalHours: 6 },
});

beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

const mount = () => renderWithClient(<GroupSyncPanel user={{ organizationId: 'org1' }} />);

describe('GroupSyncPanel', () => {
    it('shows the organisation\'s sync and its settings, and none of the directory configuration', async () => {
        fetchMock.mockResolvedValue(json(READ(true)));
        mount();
        const run = await screen.findByRole('button', { name: 'Sync now' });
        expect(run).toBeEnabled();
        expect(screen.getByText('Never synced')).toBeInTheDocument();
        expect(screen.getByText('Sync settings')).toBeInTheDocument();
        expect(screen.getByText('The directory connection itself is managed by the platform administrator.')).toBeInTheDocument();
        // The configuration fields of the Microsoft SSO section are not on this screen.
        expect(screen.queryByRole('textbox')).toBeNull();
        expect(document.querySelector('input[type="password"]')).toBeNull();
        expect(screen.queryByText('Directory (Tenant) ID')).toBeNull();
        // One read, the organisation-scoped one; never the platform configuration.
        expect(calls()).toEqual([`GET ${STATUS}`]);
    });

    it('runs the organisation\'s sync', async () => {
        fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => (init?.method === 'POST'
            ? json({ ok: true, synced: { groups: 2, users: 1 }, details: [] })
            : json(READ(true))));
        mount();
        const user = userEvent.setup();
        await user.click(await screen.findByRole('button', { name: 'Sync now' }));
        expect(await screen.findByText(/Sync completed/)).toBeInTheDocument();
        expect(calls()).toContain('POST /api/org-azure-config/org1/sync-groups');
    });

    it('offers no run while no directory is connected, and says who connects one', async () => {
        fetchMock.mockResolvedValue(json(READ(false)));
        mount();
        expect(await screen.findByRole('button', { name: 'Sync now' })).toBeDisabled();
        expect(screen.getByText('The platform administrator has not connected a directory to this organisation yet, so there is nothing to sync.')).toBeInTheDocument();
        expect(screen.queryByText('Sync settings')).toBeNull();
    });

    it('says so when the read is refused', async () => {
        fetchMock.mockResolvedValue(json({ error: 'Only organization admins can view sync status' }, 403));
        mount();
        expect(await screen.findByRole('alert')).toHaveTextContent('Only organization admins can view sync status');
        expect(screen.queryByRole('button', { name: 'Sync now' })).toBeNull();
    });
});

describe('GroupSyncPanel on the theme', () => {
    it('heads the card with the Entra ID name, and paints nothing in Microsoft blue', async () => {
        fetchMock.mockResolvedValue(json(READ(true)));
        const { container } = mount();
        expect(await screen.findByRole('heading', { name: 'Microsoft Entra ID group sync' })).toBeInTheDocument();
        await screen.findByText('Never synced');
        expect(container.innerHTML).not.toMatch(/#0078D4|rgba\(0,\s*120,\s*212/i);
        expect(container.querySelector('[style]')).toBeNull();
    });

    it('turns a setting at once, and says so when the server refuses it', async () => {
        fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => (init?.method === 'PUT'
            ? json({ error: 'Only organization admins can manage sync settings' }, 403)
            : json(READ(true))));
        mount();
        const user = userEvent.setup();
        await user.click(await screen.findByRole('switch', { name: 'Automatic periodic sync' }));
        expect(calls()).toContain('PUT /api/org-azure-config/org1/sync-groups/settings');
        expect(await screen.findByRole('alert')).toHaveTextContent('Only organization admins can manage sync settings');
    });
});
