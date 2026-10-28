import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fail, ok } from '@/test/http';

const { authFetch } = vi.hoisted(() => ({ authFetch: vi.fn() }));
vi.mock('@/utils/helpers', () => ({ API_BASE: 'https://api.test', authFetch }));

import GitHubSyncPanel from './GitHubSyncPanel';

/**
 * Characterisation of the GitHub sync panel: what each connection state shows
 * (not connected, not configured, configured), the configuration form and its
 * request, the push and push-pending actions with their messages, the detail
 * list and the disconnect confirmation.
 */

type Json = Record<string, unknown>;
const BASE = 'https://api.test/api/integrations/github-sync';

const CONFIG = { repoOwner: 'acme', repoName: 'agents', branch: 'dev', autoSync: true, lastFullSync: '2026-03-04T10:00:00Z' };
const OVERVIEW = { synced: 5, pending: 2, error: 1, total: 8 };

let status: Json;
let details: unknown[];
const route = new Map<string, () => unknown>();

/** Every request made, as `METHOD url`. */
const calls = () => authFetch.mock.calls.map(([url, opts]) => `${(opts as { method?: string } | undefined)?.method ?? 'GET'} ${String(url)}`);
const lastBody = (needle: string) => {
    const hit = authFetch.mock.calls.findLast(([url, opts]) => `${(opts as { method?: string } | undefined)?.method ?? 'GET'} ${String(url)}` === needle);
    return JSON.parse(String((hit?.[1] as { body?: string }).body));
};

beforeEach(() => {
    status = { githubConnected: true, configured: true, config: CONFIG, overview: OVERVIEW };
    details = [];
    route.clear();
    authFetch.mockReset();
    authFetch.mockImplementation((url: string, opts?: { method?: string }) => {
        const key = `${opts?.method ?? 'GET'} ${url}`;
        const custom = route.get(key);
        if (custom) return custom();
        if (key === `GET ${BASE}/status`) return ok(status);
        if (key === `GET ${BASE}/details`) return ok(details);
        return ok({});
    });
});
afterEach(() => { vi.restoreAllMocks(); });

const renderPanel = () => render(<GitHubSyncPanel user={null} />);
const ready = async () => { renderPanel(); await screen.findByRole('heading', { name: 'GitHub Sync' }); };

describe('GitHubSyncPanel: states', () => {
    it('shows a skeleton while the status loads', async () => {
        renderPanel();
        expect(document.querySelector('.animate-pulse')).not.toBeNull();
        expect(screen.queryByRole('heading', { name: 'GitHub Sync' })).toBeNull();
        await screen.findByRole('heading', { name: 'GitHub Sync' });
        expect(document.querySelector('.animate-pulse')).toBeNull();
        expect(calls()).toEqual([`GET ${BASE}/status`]);
    });

    it('asks to connect GitHub first when it is not connected', async () => {
        status = { githubConnected: false };
        await ready();
        expect(screen.getByText('GitHub Not Connected')).toBeInTheDocument();
        expect(screen.queryByText('Set Up Agent Sync')).toBeNull();
    });

    it('still leaves the skeleton when the status request fails', async () => {
        route.set(`GET ${BASE}/status`, () => fail(500));
        const error = vi.spyOn(console, 'error').mockImplementation(() => {});
        await ready();
        expect(screen.getByText('GitHub Not Connected')).toBeInTheDocument();
        expect(error).not.toHaveBeenCalled();
    });

    it('logs a status request that throws and leaves the skeleton', async () => {
        route.set(`GET ${BASE}/status`, () => Promise.reject(new Error('down')));
        const error = vi.spyOn(console, 'error').mockImplementation(() => {});
        await ready();
        expect(error).toHaveBeenCalledWith('[GitHubSync] Status fetch error:', expect.any(Error));
    });

    it('offers to set up the sync when connected but not configured', async () => {
        status = { githubConnected: true, configured: false };
        const user = userEvent.setup();
        await ready();
        expect(screen.getByText('Set Up Agent Sync')).toBeInTheDocument();
        await user.click(screen.getByRole('button', { name: 'Configure Repository' }));
        expect(screen.getByText('Repository Configuration')).toBeInTheDocument();
        expect(screen.queryByText('Set Up Agent Sync')).toBeNull();
        expect(screen.getByRole('button', { name: 'Connect Repository' })).toBeInTheDocument();
        await user.click(screen.getByRole('button', { name: 'Cancel' }));
        expect(screen.getByText('Set Up Agent Sync')).toBeInTheDocument();
    });

    it('shows the connected repo, its stats, the link and the last full sync', async () => {
        await ready();
        expect(screen.getByRole('heading', { name: 'acme/agents' })).toBeInTheDocument();
        expect(screen.getByText('Connected')).toBeInTheDocument();
        expect(screen.getByText('auto-sync')).toBeInTheDocument();
        expect(screen.getByText('dev')).toBeInTheDocument();
        for (const [label, value] of [['Synced', '5'], ['Pending', '2'], ['Errors', '1'], ['Total', '8']]) {
            expect(screen.getByText(label).previousElementSibling).toHaveTextContent(value);
        }
        expect(screen.getByRole('link', { name: 'Open in GitHub' })).toHaveAttribute('href', 'https://github.com/acme/agents');
        expect(screen.getByText(`Last full sync: ${new Date('2026-03-04T10:00:00Z').toLocaleString()}`)).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Push 2 Pending' })).toBeInTheDocument();
    });

    it('hides the pending button, the stats, the auto-sync badge and the last sync when there is nothing to show', async () => {
        status = { githubConnected: true, configured: true, config: { ...CONFIG, autoSync: false, lastFullSync: null }, overview: null };
        await ready();
        expect(screen.queryByText('auto-sync')).toBeNull();
        expect(screen.queryByText('Synced')).toBeNull();
        expect(screen.queryByText(/Last full sync/)).toBeNull();
        expect(screen.queryByRole('button', { name: /Pending/ })).toBeNull();
        expect(screen.getByRole('button', { name: 'Push All to GitHub' })).toBeInTheDocument();
    });
});

describe('GitHubSyncPanel: configuration', () => {
    it('fills the form from the saved config when editing, and Cancel returns to the dashboard', async () => {
        const user = userEvent.setup();
        await ready();
        await user.click(screen.getByTitle('Edit configuration'));
        expect(screen.getByPlaceholderText('your-username')).toHaveValue('acme');
        expect(screen.getByPlaceholderText('beeflow-agents')).toHaveValue('agents');
        expect(screen.getByPlaceholderText('main')).toHaveValue('dev');
        expect(screen.getByRole('button', { name: 'Update Configuration' })).toBeInTheDocument();
        expect(screen.queryByText('Connected')).toBeNull();
        await user.click(screen.getByRole('button', { name: 'Cancel' }));
        expect(screen.getByText('Connected')).toBeInTheDocument();
    });

    it('requires owner and name, without sending anything', async () => {
        status = { githubConnected: true, configured: false };
        const user = userEvent.setup();
        await ready();
        await user.click(screen.getByRole('button', { name: 'Configure Repository' }));
        await user.type(screen.getByPlaceholderText('your-username'), '   ');
        await user.click(screen.getByRole('button', { name: 'Connect Repository' }));
        expect(await screen.findByText('Repository owner and name are required')).toBeInTheDocument();
        expect(calls()).toEqual([`GET ${BASE}/status`]);
    });

    it('saves trimmed values with the branch defaulted, then reloads the status and closes the form', async () => {
        status = { githubConnected: true, configured: false };
        const user = userEvent.setup();
        await ready();
        await user.click(screen.getByRole('button', { name: 'Configure Repository' }));
        await user.type(screen.getByPlaceholderText('your-username'), ' acme ');
        await user.type(screen.getByPlaceholderText('beeflow-agents'), ' agents ');
        await user.clear(screen.getByPlaceholderText('main'));
        await user.click(screen.getByRole('button', { name: '' }));
        status = { githubConnected: true, configured: true, config: { ...CONFIG, autoSync: true, branch: 'main' }, overview: OVERVIEW };
        await user.click(screen.getByRole('button', { name: 'Connect Repository' }));
        expect(await screen.findByText('GitHub sync configured successfully!')).toBeInTheDocument();
        expect(lastBody(`POST ${BASE}/configure`)).toEqual({ repoOwner: 'acme', repoName: 'agents', branch: 'main', autoSync: true });
        await screen.findByRole('heading', { name: 'acme/agents' });
        expect(calls().filter((c) => c === `GET ${BASE}/status`)).toHaveLength(2);
    });

    it('shows the server error, or a fallback, and keeps the form open', async () => {
        status = { githubConnected: true, configured: false };
        route.set(`POST ${BASE}/configure`, () => fail(400, { error: 'repo not found' }));
        const user = userEvent.setup();
        await ready();
        await user.click(screen.getByRole('button', { name: 'Configure Repository' }));
        await user.type(screen.getByPlaceholderText('your-username'), 'a');
        await user.type(screen.getByPlaceholderText('beeflow-agents'), 'b');
        await user.click(screen.getByRole('button', { name: 'Connect Repository' }));
        expect(await screen.findByText('repo not found')).toBeInTheDocument();
        expect(screen.getByText('Repository Configuration')).toBeInTheDocument();
        route.set(`POST ${BASE}/configure`, () => fail(400, {}));
        await user.click(screen.getByRole('button', { name: 'Connect Repository' }));
        expect(await screen.findByText('Configuration failed')).toBeInTheDocument();
        route.set(`POST ${BASE}/configure`, () => Promise.reject(new Error('x')));
        await user.click(screen.getByRole('button', { name: 'Connect Repository' }));
        expect(await screen.findByText('Failed to configure sync')).toBeInTheDocument();
    });
});

describe('GitHubSyncPanel: pushing', () => {
    it('pushes everything and reports the counts with the unchanged ones', async () => {
        route.set(`POST ${BASE}/push`, () => ok({ results: { agents: { pushed: 3, skipped: 1 }, skills: { pushed: 2, skipped: 2 } } }));
        const user = userEvent.setup();
        await ready();
        await user.click(screen.getByRole('button', { name: 'Push All to GitHub' }));
        expect(await screen.findByText('Sync complete! 3 agents, 2 skills pushed. (3 unchanged)')).toBeInTheDocument();
        expect(calls().filter((c) => c === `GET ${BASE}/status`)).toHaveLength(2);
    });

    it('leaves the unchanged note out when nothing was skipped', async () => {
        route.set(`POST ${BASE}/push`, () => ok({ results: { agents: { pushed: 1, skipped: 0 }, skills: { pushed: 0, skipped: 0 } } }));
        const user = userEvent.setup();
        await ready();
        await user.click(screen.getByRole('button', { name: 'Push All to GitHub' }));
        expect(await screen.findByText('Sync complete! 1 agents, 0 skills pushed.')).toBeInTheDocument();
    });

    it('reports a refused or failed push', async () => {
        route.set(`POST ${BASE}/push`, () => fail(500, { error: 'rate limited' }));
        const user = userEvent.setup();
        await ready();
        await user.click(screen.getByRole('button', { name: 'Push All to GitHub' }));
        expect(await screen.findByText('rate limited')).toBeInTheDocument();
        route.set(`POST ${BASE}/push`, () => fail(500, {}));
        await user.click(screen.getByRole('button', { name: 'Push All to GitHub' }));
        expect(await screen.findByText('Sync failed')).toBeInTheDocument();
        route.set(`POST ${BASE}/push`, () => Promise.reject(new Error('boom')));
        await user.click(screen.getByRole('button', { name: 'Push All to GitHub' }));
        expect(await screen.findByText('Sync failed: boom')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Push All to GitHub' })).toBeEnabled();
    });

    it('pushes the pending changes and reports them', async () => {
        route.set(`POST ${BASE}/push-pending`, () => ok({ results: { pushed: 2, errors: 1 } }));
        const user = userEvent.setup();
        await ready();
        await user.click(screen.getByRole('button', { name: 'Push 2 Pending' }));
        expect(await screen.findByText('Pushed 2 pending changes. (1 errors)')).toBeInTheDocument();
    });

    it('reports a refused or failed pending push', async () => {
        route.set(`POST ${BASE}/push-pending`, () => fail(500, {}));
        const user = userEvent.setup();
        await ready();
        await user.click(screen.getByRole('button', { name: 'Push 2 Pending' }));
        expect(await screen.findByText('Push failed')).toBeInTheDocument();
        route.set(`POST ${BASE}/push-pending`, () => Promise.reject(new Error('boom')));
        await user.click(screen.getByRole('button', { name: 'Push 2 Pending' }));
        expect(await screen.findByText('Push failed: boom')).toBeInTheDocument();
    });

    it('clears the message after five seconds', async () => {
        const timeouts = vi.spyOn(globalThis, 'setTimeout');
        route.set(`POST ${BASE}/push-pending`, () => ok({ results: { pushed: 1, errors: 0 } }));
        const user = userEvent.setup();
        await ready();
        await user.click(screen.getByRole('button', { name: 'Push 2 Pending' }));
        await screen.findByText('Pushed 1 pending changes.');
        const timer = timeouts.mock.calls.findLast(([, ms]) => ms === 5000);
        expect(timer).toBeDefined();
        await waitFor(() => { (timer?.[0] as () => void)(); expect(screen.queryByText('Pushed 1 pending changes.')).toBeNull(); });
    });
});

describe('GitHubSyncPanel: details and disconnect', () => {
    it('loads the details on demand, lists them and hides them again', async () => {
        details = [
            { id: '1', resource_type: 'agent', resource_id: 'abcdefghijkl', sync_status: 'synced', last_synced_at: '2026-03-04T10:00:00Z' },
            { id: '2', resource_type: 'skill', resource_id: 'zyxwvutsrq', sync_status: 'error', error_message: 'conflict' },
            { id: '3', resource_type: 'agent', resource_id: '12345678901', sync_status: 'pending' },
            { id: '4', resource_type: 'agent', resource_id: '98765432101', sync_status: 'other' },
        ];
        const user = userEvent.setup();
        await ready();
        await user.click(screen.getByRole('button', { name: /Show sync details/ }));
        expect(await screen.findByText('agent/abcdefgh')).toBeInTheDocument();
        expect(calls()).toContain(`GET ${BASE}/details`);
        expect(screen.getByText('skill/zyxwvuts')).toBeInTheDocument();
        expect(screen.getByText('conflict')).toBeInTheDocument();
        expect(screen.getByText(new Date('2026-03-04T10:00:00Z').toLocaleString())).toBeInTheDocument();
        expect(screen.getByText('synced')).toHaveClass('text-green-500');
        expect(screen.getByText('pending')).toHaveClass('text-amber-500');
        expect(screen.getByText('error')).toHaveClass('text-red-500');
        await user.click(screen.getByRole('button', { name: /Hide sync details/ }));
        expect(screen.queryByText('agent/abcdefgh')).toBeNull();
    });

    it('says so when there is no sync data yet', async () => {
        const user = userEvent.setup();
        await ready();
        await user.click(screen.getByRole('button', { name: /Show sync details/ }));
        expect(await screen.findByText('No sync data yet. Push to GitHub to get started.')).toBeInTheDocument();
    });

    it('stays collapsed when the details request fails', async () => {
        route.set(`GET ${BASE}/details`, () => Promise.reject(new Error('x')));
        const error = vi.spyOn(console, 'error').mockImplementation(() => {});
        const user = userEvent.setup();
        await ready();
        await user.click(screen.getByRole('button', { name: /Show sync details/ }));
        await waitFor(() => expect(error).toHaveBeenCalledWith('[GitHubSync] Details fetch error:', expect.any(Error)));
        expect(screen.getByRole('button', { name: /Show sync details/ })).toBeInTheDocument();
    });

    it('disconnects after a confirmation and resets to the set-up card', async () => {
        const user = userEvent.setup();
        await ready();
        await user.click(screen.getByTitle('Disconnect'));
        const dialog = await screen.findByRole('dialog', { name: 'Disconnect GitHub sync?' });
        expect(dialog).toHaveTextContent('This will stop syncing agent configurations.');
        await user.click(within(dialog).getByRole('button', { name: 'Disconnect' }));
        expect(await screen.findByText('GitHub sync disconnected')).toBeInTheDocument();
        expect(calls()).toContain(`DELETE ${BASE}/configure`);
        expect(screen.getByText('Set Up Agent Sync')).toBeInTheDocument();
        await user.click(screen.getByRole('button', { name: 'Configure Repository' }));
        expect(screen.getByPlaceholderText('your-username')).toHaveValue('');
        expect(screen.getByPlaceholderText('main')).toHaveValue('main');
    });

    it('does nothing when the confirmation is cancelled, and reports a failed disconnect request', async () => {
        const user = userEvent.setup();
        await ready();
        await user.click(screen.getByTitle('Disconnect'));
        await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: /Cancel/ }));
        expect(calls()).not.toContain(`DELETE ${BASE}/configure`);
        route.set(`DELETE ${BASE}/configure`, () => Promise.reject(new Error('x')));
        await user.click(screen.getByTitle('Disconnect'));
        await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Disconnect' }));
        expect(await screen.findByText('Failed to disconnect')).toBeInTheDocument();
        expect(screen.getByText('Connected')).toBeInTheDocument();
    });

    it('keeps the dashboard when the server refuses to disconnect', async () => {
        route.set(`DELETE ${BASE}/configure`, () => fail(403));
        const user = userEvent.setup();
        await ready();
        await user.click(screen.getByTitle('Disconnect'));
        await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Disconnect' }));
        await waitFor(() => expect(calls()).toContain(`DELETE ${BASE}/configure`));
        expect(screen.queryByText('GitHub sync disconnected')).toBeNull();
        expect(screen.getByText('Connected')).toBeInTheDocument();
    });
});
