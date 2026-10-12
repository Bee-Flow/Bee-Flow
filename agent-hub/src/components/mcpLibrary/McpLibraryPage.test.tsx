// Settings → Organisation → MCP library, the page as an org admin sees it:
// loading, a failed load (and the licence gate, which must not offer a retry
// that cannot help), the three sections, the policy lock on a catalogue card,
// search and category filters, and the server administrator's extra tab.
//
// Requests go through the real apiClient into a mocked authFetch.

import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, it, vi } from 'vitest';
import {
    deferred, fakeBackend, library, ORG_PATH, POLICY_PATH, policyPayload,
} from '@/test/mcpLibraryKit';
import type { Reply } from '@/test/mcpLibraryKit';
import { withQueryClient } from '@/test/queryWrapper';
import McpLibraryPage from './McpLibraryPage';

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));
vi.mock('../../utils/helpers', async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    API_BASE: '',
    authFetch: fetchMock,
}));

let api: ReturnType<typeof fakeBackend>;
beforeEach(() => { api = fakeBackend(fetchMock); });

function renderPage() {
    const user = userEvent.setup();
    render(withQueryClient(<McpLibraryPage />));
    return user;
}

/** Render with a library and wait until the catalogue is on screen. */
async function renderLoaded(over: Parameters<typeof library>[0] = {}) {
    api.on('GET', ORG_PATH, { body: library(over) });
    const user = renderPage();
    await screen.findByRole('heading', { name: /^Linear/ });
    return user;
}

const region = (name: string | RegExp) => screen.getByRole('region', { name });
const catalogueHeadings = () => within(region('Add a server')).queryAllByRole('heading', { level: 4 }).map(h => h.textContent);

it('shows a loading placeholder until the library arrives', async () => {
    const gate = deferred<Reply>();
    api.on('GET', ORG_PATH, () => gate.promise);
    renderPage();
    expect(screen.getByRole('status')).toHaveTextContent('Loading the MCP library…');
    gate.resolve({ body: library() });
    expect(await screen.findByRole('heading', { name: /^Linear/ })).toBeInTheDocument();
    expect(screen.queryByText('Loading the MCP library…')).not.toBeInTheDocument();
});

it('says when the library could not be loaded, with the server\'s reason, and tries again on request', async () => {
    api.on('GET', ORG_PATH, { status: 403, body: { error: 'Only an organisation admin can open the MCP library.', code: 'not_org_admin' } });
    const user = renderPage();
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('The MCP library could not be loaded');
    expect(alert).toHaveTextContent('Only an organisation admin can open the MCP library.');

    api.on('GET', ORG_PATH, { body: library() });
    await user.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('heading', { name: /^Linear/ })).toBeInTheDocument();
    expect(api.bodies('GET', ORG_PATH)).toHaveLength(2);
});

it('a licence gate (403 feature_locked) explains the plan and offers no retry that cannot help', async () => {
    api.on('GET', ORG_PATH, { status: 403, body: { error: 'feature_locked' } });
    renderPage();
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('The MCP library is not part of your plan');
    expect(alert).toHaveTextContent('Ask your administrator about the Enterprise plan.');
    // The bare token is a code, never a sentence on screen.
    expect(alert).not.toHaveTextContent('feature_locked');
    expect(within(alert).queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
    // One request: a 403 is not retried behind the user's back either.
    expect(api.bodies('GET', ORG_PATH)).toHaveLength(1);
});

it('shows the policy, installed and in-use server-wide servers together, and idle server-wide ones apart', async () => {
    await renderLoaded();
    expect(screen.getByText('Server policy: Official servers only')).toBeInTheDocument();

    const inUse = region('In your organisation');
    expect(within(inUse).getByRole('button', { name: 'Open Sentry' })).toHaveTextContent('Running');
    expect(within(inUse).getByRole('button', { name: 'Open GitHub' })).toHaveTextContent('In use');
    expect(within(inUse).queryByRole('button', { name: 'Open Fetch' })).not.toBeInTheDocument();

    const idle = region(/^From your server administrator/);
    expect(within(idle).getByRole('button', { name: 'Open Fetch' })).toHaveTextContent('Off');
    expect(within(idle).queryByRole('button', { name: 'Open GitHub' })).not.toBeInTheDocument();

    expect(catalogueHeadings()).toEqual(['Linear', 'Stripe', 'Context Docs', 'Self-hosted GitLab']);
});

it('an organisation with nothing in use gets the empty state, and no idle section without idle servers', async () => {
    await renderLoaded({ installed: [], serverWide: [] });
    expect(within(region('In your organisation')).getByText('No MCP servers yet')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: /^From your server administrator/ })).not.toBeInTheDocument();
});

it('a catalogue entry the policy does not allow says so, with the reason, and has no Add button', async () => {
    await renderLoaded();
    const add = region('Add a server');
    expect(within(add).getAllByRole('button', { name: 'Add' })).toHaveLength(3);
    expect(within(add).getByRole('button', { name: 'Add', description: /^Linear/ })).toBeEnabled();
    expect(within(add).queryByRole('button', { name: 'Add', description: /GitLab/ })).not.toBeInTheDocument();
    expect(within(add).getByText('Not allowed')).toHaveAttribute('title', 'Your own instances need your server administrator to allow custom addresses.');
});

it('with the policy switched off, a locked entry gives that reason instead', async () => {
    await renderLoaded({ policy: { remote: 'off', allowsCustomUrls: false, allowedHosts: [] } });
    expect(screen.getByText('Not allowed')).toHaveAttribute('title', 'Your server administrator has switched off adding MCP servers.');
    // Nothing to ask the server admin for when everything is off.
    expect(screen.queryByText(/Need a server that is not listed\?/)).not.toBeInTheDocument();
});

it('offers "Connect another server" only when the policy allows custom addresses', async () => {
    await renderLoaded();
    expect(screen.queryByRole('button', { name: /Connect another server/ })).not.toBeInTheDocument();
    expect(screen.getByText(/Need a server that is not listed\?/)).toBeInTheDocument();
});

it('with custom addresses allowed, the custom card opens the wizard without a library entry', async () => {
    const user = await renderLoaded({ policy: { remote: 'any', allowsCustomUrls: true, allowedHosts: [] } });
    expect(screen.queryByText(/Need a server that is not listed\?/)).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Connect another server/ }));
    expect(await screen.findByRole('dialog', { name: 'Connect a server' })).toBeInTheDocument();
});

it('search narrows every section; "Clear the filters" brings everything back', async () => {
    const user = await renderLoaded();
    const search = screen.getByRole('searchbox', { name: 'Search servers' });

    await user.type(search, 'stripe');
    expect(catalogueHeadings()).toEqual(['Stripe']);
    expect(within(region('In your organisation')).getByText('No server matches.')).toBeInTheDocument();

    await user.clear(search);
    await user.type(search, 'no such server');
    expect(catalogueHeadings()).toEqual([]);
    await user.click(within(region('Add a server')).getByRole('button', { name: 'Clear the filters' }));

    expect(search).toHaveValue('');
    expect(catalogueHeadings()).toHaveLength(4);
    expect(within(region('In your organisation')).getByRole('button', { name: 'Open Sentry' })).toBeInTheDocument();
});

it('search matches a host too, and the field\'s own clear button empties it', async () => {
    const user = await renderLoaded();
    const search = screen.getByRole('searchbox', { name: 'Search servers' });
    await user.type(search, 'mcp.sentry.dev');
    expect(within(region('In your organisation')).getByRole('button', { name: 'Open Sentry' })).toBeInTheDocument();
    expect(within(region('In your organisation')).queryByRole('button', { name: 'Open GitHub' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Clear the search' }));
    expect(search).toHaveValue('');
    expect(within(region('In your organisation')).getByRole('button', { name: 'Open GitHub' })).toBeInTheDocument();
});

it('category chips filter the catalogue, and clearing the filters resets the category too', async () => {
    const user = await renderLoaded();
    const chips = screen.getByRole('group', { name: 'Categories' });
    expect(within(chips).getAllByRole('button').map(b => b.textContent)).toEqual(['All', 'Development', 'Payments', 'Documentation']);

    await user.click(within(chips).getByRole('button', { name: 'Payments' }));
    expect(within(chips).getByRole('button', { name: 'Payments' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(chips).getByRole('button', { name: 'All' })).toHaveAttribute('aria-pressed', 'false');
    expect(catalogueHeadings()).toEqual(['Stripe']);

    await user.type(screen.getByRole('searchbox', { name: 'Search servers' }), 'linear');
    expect(catalogueHeadings()).toEqual([]);
    await user.click(within(region('Add a server')).getByRole('button', { name: 'Clear the filters' }));
    expect(within(chips).getByRole('button', { name: 'All' })).toHaveAttribute('aria-pressed', 'true');
    expect(catalogueHeadings()).toHaveLength(4);
});

it('Add opens the wizard for that entry; a card opens its drawer', async () => {
    const user = await renderLoaded();
    await user.click(within(region('Add a server')).getByRole('button', { name: 'Add', description: /^Stripe/ }));
    expect(await screen.findByRole('dialog', { name: 'Add Stripe' })).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: 'Add Stripe' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Open Fetch' }));
    expect(await screen.findByRole('dialog', { name: 'Fetch' })).toHaveTextContent('Installed by your server administrator');
});

it('a member who is not a server administrator gets no tabs and no "Change policy"', async () => {
    await renderLoaded();
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Change policy' })).not.toBeInTheDocument();
});

it('a server administrator gets the "Server-wide" tab with the policy and the server-wide servers', async () => {
    api.on('GET', POLICY_PATH, { body: policyPayload() });
    api.on('GET', '/ai/mcp-servers', { body: { servers: [{ id: 'github', name: 'GitHub', enabled: true, status: 'ready', transport: 'stdio', tools_cache: [{ name: 'search_code' }] }] } });
    const user = await renderLoaded({ isServerAdmin: true });

    expect(screen.getByRole('tab', { name: 'Your organisation' })).toHaveAttribute('aria-selected', 'true');
    await user.click(screen.getByRole('tab', { name: 'Server-wide' }));

    expect(await screen.findByRole('region', { name: 'What organisation admins may install' })).toBeInTheDocument();
    const installed = screen.getByRole('region', { name: 'Installed for every organisation' });
    expect(await within(installed).findByRole('button', { name: 'Open GitHub' })).toHaveTextContent('Ready');
    expect(screen.queryByRole('region', { name: 'Add a server' })).not.toBeInTheDocument();
});

it('"Change policy" takes a server administrator to the Server-wide tab', async () => {
    api.on('GET', POLICY_PATH, { body: policyPayload() });
    api.on('GET', '/ai/mcp-servers', { body: { servers: [] } });
    const user = await renderLoaded({ isServerAdmin: true });
    await user.click(screen.getByRole('button', { name: 'Change policy' }));
    expect(screen.getByRole('tab', { name: 'Server-wide' })).toHaveAttribute('aria-selected', 'true');
    expect(await screen.findByText(/No server-wide MCP servers\./)).toBeInTheDocument();
});
