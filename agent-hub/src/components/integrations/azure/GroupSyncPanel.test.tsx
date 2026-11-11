/**
 * Settings > Organisation > Group sync for an organisation admin
 * (GroupSyncPanel): it reads the organisation-scoped status route, shows the
 * last run, "Sync now" and the sync settings, says the directory connection is
 * the platform administrator's, and shows no field of that connection. The
 * platform admin's Microsoft SSO section still carries the same sync part
 * (GroupSyncBlock) under the credentials.
 */
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithClient } from '@/test/render';
import GroupSyncPanel from './GroupSyncPanel';
import SSOSection from './SSOSection';

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
        const run = await screen.findByRole('button', { name: 'Sync Now' });
        expect(run).toBeEnabled();
        expect(screen.getByText('Never synced')).toBeInTheDocument();
        expect(screen.getByText('Sync Settings')).toBeInTheDocument();
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
        await user.click(await screen.findByRole('button', { name: 'Sync Now' }));
        expect(await screen.findByText(/Sync completed/)).toBeInTheDocument();
        expect(calls()).toContain('POST /api/org-azure-config/org1/sync-groups');
    });

    it('offers no run while no directory is connected, and says who connects one', async () => {
        fetchMock.mockResolvedValue(json(READ(false)));
        mount();
        expect(await screen.findByRole('button', { name: 'Sync Now' })).toBeDisabled();
        expect(screen.getByText('The platform administrator has not connected a directory to this organisation yet, so there is nothing to sync.')).toBeInTheDocument();
        expect(screen.queryByText('Sync Settings')).toBeNull();
    });

    it('says so when the read is refused', async () => {
        fetchMock.mockResolvedValue(json({ error: 'Only organization admins can view sync status' }, 403));
        mount();
        expect(await screen.findByRole('alert')).toHaveTextContent('Only organization admins can view sync status');
        expect(screen.queryByRole('button', { name: 'Sync Now' })).toBeNull();
    });
});

describe('the platform admin\'s Microsoft SSO section', () => {
    it('still carries the sync part under the credentials', async () => {
        const noop = vi.fn();
        renderWithClient(
            <SSOSection
                ssoClientId="" setSsoClientId={noop} ssoClientSecret="" setSsoClientSecret={noop} hasSsoClientSecret={false}
                ssoTenantId="common" setSsoTenantId={noop} autoApproveSSO={false} setAutoApproveSSO={noop}
                saving={false} saved={false} handleSave={noop} orgId="org1"
                groupSyncSettings={null} groupSyncStatus={null} onSyncSettingsChange={noop} onSyncStatusChange={noop}
            />,
        );
        expect(screen.getByText('Directory (Tenant) ID')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Sync Now' })).toBeDisabled();
        expect(screen.getByText('Configure Microsoft SSO credentials above before using group sync.')).toBeInTheDocument();
        await waitFor(() => expect(fetchMock).not.toHaveBeenCalled());
    });
});
