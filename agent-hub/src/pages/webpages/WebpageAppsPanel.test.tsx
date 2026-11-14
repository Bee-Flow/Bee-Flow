import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * WebpageAppsPanel — the IDE "Apps & data" pane. authFetch and the automation
 * API hook are mocked; the catalog/grants fixtures mirror the server contracts
 * (routes/webpagesGrants.js + routes/automation/catalog.js).
 */

const CATALOG = {
    apps: [
        {
            id: 'gmail', label: 'Gmail', available: true,
            actions: [{ name: 'gmail_search', label: 'gmail search', integrationId: 'gmail' }],
        },
        {
            id: 'youtrack', label: 'YouTrack', available: false,
            actions: [{ name: 'youtrack_get_issue', label: 'youtrack get issue', integrationId: 'youtrack' }],
        },
    ],
};

const GRANTS = {
    ai: { enabled: true },
    integrations: [
        { tool: 'gmail_search', label: null, hasFixedArgs: true, integrationId: 'gmail', integrationLabel: 'Gmail', available: true },
        { tool: 'slack_post', label: 'Team ping', hasFixedArgs: false, integrationId: 'slack', integrationLabel: 'Slack', available: false },
    ],
    automations: [{ automationId: 'auto-1', label: 'Nightly sync' }],
    discoveryFailed: false,
};

type FetchInit = { method?: string; body: string };
const authFetch = vi.fn<(url: string, init?: FetchInit) => Promise<unknown>>();
vi.mock('../../utils/helpers', () => ({
    API_BASE: 'https://host.example',
    authFetch: (...args: Parameters<typeof authFetch>) => authFetch(...args),
}));

const getCatalog = vi.fn(async () => CATALOG);
const listAutomations = vi.fn(async () => ({ automations: [{ id: 'auto-2', title: 'Weekly report' }] }));
vi.mock('../../hooks/useAutomationApi', () => ({
    default: () => ({ getCatalog, listAutomations }),
}));

import { withQueryClient } from '../../test/queryWrapper';
import WebpageAppsPanel from './WebpageAppsPanel';

function grantsResponse(body = GRANTS, ok = true, status = 200) {
    return { ok, status, json: async () => body };
}

beforeEach(() => {
    authFetch.mockReset();
    getCatalog.mockClear();
    listAutomations.mockClear();
    authFetch.mockImplementation(async (url) => {
        if (String(url).includes('/grants')) return grantsResponse();
        throw new Error(`unexpected fetch: ${url}`);
    });
});

describe('WebpageAppsPanel', () => {
    it('lists granted apps with their live status and automations', async () => {
        render(withQueryClient(<WebpageAppsPanel webpageId="wp1" />));
        await waitFor(() => expect(screen.getByText('gmail search')).toBeTruthy());
        expect(screen.getByText('Connected')).toBeTruthy();
        expect(screen.getByText('Needs reconnect')).toBeTruthy();
        expect(screen.getByText('Team ping')).toBeTruthy();
        expect(screen.getByText('Nightly sync')).toBeTruthy();
    });

    it('offers a reconnect deep link (with return URL) for a disconnected grant', async () => {
        render(withQueryClient(<WebpageAppsPanel webpageId="wp1" />));
        const link = await screen.findByRole('link', { name: 'Reconnect' });
        expect(link.getAttribute('href')).toBe(
            '/app/settings/integrations?return=%2Fapp%2Fstudio%2Fwebpages%2Fwp1',
        );
    });

    it('revokes an integration grant via DELETE', async () => {
        const user = userEvent.setup();
        render(withQueryClient(<WebpageAppsPanel webpageId="wp1" />));
        const btn = await screen.findByRole('button', { name: 'Remove gmail_search' });
        await user.click(btn);
        await waitFor(() => expect(authFetch).toHaveBeenCalledWith(
            'https://host.example/api/webpages/wp1/grants/integrations/gmail_search',
            { method: 'DELETE' },
        ));
    });

    it('greys out unconnected apps in the picker and points at Settings', async () => {
        const user = userEvent.setup();
        render(withQueryClient(<WebpageAppsPanel webpageId="wp1" />));
        await user.click(await screen.findByRole('button', { name: /Add an app/ }));
        const appSelect = await screen.findByLabelText<HTMLSelectElement>('App');
        const youtrackOption = [...appSelect.options].find(o => o.value === 'youtrack') as HTMLOptionElement;
        expect(youtrackOption.disabled).toBe(true);
        // Select it anyway (programmatically) → the inline connect guidance appears.
        fireEvent.change(appSelect, { target: { value: 'youtrack' } });
        const link = await screen.findByRole('link', { name: /Connect it in Settings → Connections/ });
        expect(link.getAttribute('href')).toContain('/app/settings/integrations?return=');
    });

    it('grants a connected app action via POST', async () => {
        const user = userEvent.setup();
        render(withQueryClient(<WebpageAppsPanel webpageId="wp1" />));
        await user.click(await screen.findByRole('button', { name: /Add an app/ }));
        await user.selectOptions(await screen.findByLabelText('App'), 'gmail');
        await user.selectOptions(await screen.findByLabelText('Action'), 'gmail_search');
        await user.click(screen.getByRole('button', { name: /Add to page/ }));
        await waitFor(() => expect(authFetch).toHaveBeenCalledWith(
            'https://host.example/api/webpages/wp1/grants/integrations',
            expect.objectContaining({ method: 'POST' }),
        ));
        const body = JSON.parse((authFetch.mock.calls.find(c => String(c[0]).endsWith('/integrations')) as [string, FetchInit])[1].body);
        expect(body).toEqual({ tool: 'gmail_search' });
    });

    it('surfaces the server connection_required error when the grant is refused', async () => {
        const user = userEvent.setup();
        authFetch.mockImplementation(async (url, opts) => {
            if (opts?.method === 'POST') {
                return { ok: false, status: 409, json: async () => ({ error: 'Connect YouTrack first.', code: 'connection_required', provider: 'youtrack' }) };
            }
            return grantsResponse();
        });
        render(withQueryClient(<WebpageAppsPanel webpageId="wp1" />));
        await user.click(await screen.findByRole('button', { name: /Add an app/ }));
        await user.selectOptions(await screen.findByLabelText('App'), 'gmail');
        await user.selectOptions(await screen.findByLabelText('Action'), 'gmail_search');
        await user.click(screen.getByRole('button', { name: /Add to page/ }));
        await waitFor(() => expect(screen.getByText('Connect YouTrack first.')).toBeTruthy());
        expect(screen.getByRole('link', { name: 'Reconnect it' }).getAttribute('href')).toContain('/app/settings/integrations');
    });

    it('a refused grants read shows the server text and says the lists are unread, not empty', async () => {
        authFetch.mockImplementation(async () => ({ ok: false, status: 403, json: async () => ({ error: 'Not your page.' }) }));
        render(withQueryClient(<WebpageAppsPanel webpageId="wp1" />));
        expect(await screen.findByRole('alert')).toHaveTextContent('Not your page.');
        expect(screen.getByTestId('apps-empty')).toHaveTextContent(/could not be read/);
        // The catalog and the automations are still asked: the pane stays usable without the grants.
        expect(getCatalog).toHaveBeenCalledTimes(1);
        expect(listAutomations).toHaveBeenCalledTimes(1);
    });

    it('a failed catalog keeps the grants and switches "Add an app" off', async () => {
        getCatalog.mockRejectedValueOnce(new Error('automations are off'));
        render(withQueryClient(<WebpageAppsPanel webpageId="wp1" />));
        expect(await screen.findByText('gmail search')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /Add an app/ })).toBeDisabled();
        expect(screen.getByText(/app catalog couldn't be loaded/)).toBeInTheDocument();
    });

    it('asks the grants, the catalog and the automations again after a revoke and on Refresh', async () => {
        const user = userEvent.setup();
        render(withQueryClient(<WebpageAppsPanel webpageId="wp1" />));
        await user.click(await screen.findByRole('button', { name: 'Remove gmail_search' }));
        const grantReads = () => authFetch.mock.calls.filter(c => String(c[0]).endsWith('/grants') && !c[1]).length;
        await waitFor(() => expect(grantReads()).toBe(2));
        await waitFor(() => expect(getCatalog).toHaveBeenCalledTimes(2));
        expect(listAutomations).toHaveBeenCalledTimes(2);
        await user.click(screen.getByRole('button', { name: 'Refresh apps and grants' }));
        await waitFor(() => expect(grantReads()).toBe(3));
        await waitFor(() => expect(getCatalog).toHaveBeenCalledTimes(3));
    });

    it('a refused revoke shows the server text and asks nothing again', async () => {
        const user = userEvent.setup();
        authFetch.mockImplementation(async (_url, opts) => (opts?.method === 'DELETE'
            ? { ok: false, status: 409, json: async () => ({ error: 'Still in use.' }) }
            : grantsResponse()));
        render(withQueryClient(<WebpageAppsPanel webpageId="wp1" />));
        await user.click(await screen.findByRole('button', { name: 'Remove gmail_search' }));
        expect(await screen.findByRole('alert')).toHaveTextContent('Still in use.');
        expect(getCatalog).toHaveBeenCalledTimes(1);
    });

    it('renders the owner-only note for read-only viewers', () => {
        render(withQueryClient(<WebpageAppsPanel webpageId="wp1" readOnly />));
        expect(screen.getByText(/Only the page owner/)).toBeTruthy();
        expect(authFetch).not.toHaveBeenCalled();
    });
});
