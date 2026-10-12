// Settings → Security → MCP tokens: the list (servers with their level, tool
// limits, addresses, expiry, last use, revoked), the legacy notice, the create
// dialog and the one-time reveal of the secret, and revoking behind the app's
// own confirm dialog. Requests go through the real apiClient into a mocked
// authFetch.

import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, it, vi } from 'vitest';
import type { McpTokenRecord } from '../../api/queries/mcpAccess';
import { fakeBackend } from '@/test/mcpLibraryKit';
import { withQueryClient } from '@/test/queryWrapper';
import McpTokensPanel from './McpTokensPanel';

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));
vi.mock('../../utils/helpers', async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    API_BASE: '',
    authFetch: fetchMock,
}));

const PATH = '/api/mcp-tokens';

function record(over: Partial<McpTokenRecord> = {}): McpTokenRecord {
    return {
        id: 'tok-1',
        name: 'Claude Code laptop',
        scopes: { integrations: { level: 'read' }, cms: { level: 'write', publish: true } },
        ipAllowlist: ['203.0.113.0/24'],
        expiresAt: '2099-01-01T00:00:00.000Z',
        lastUsedAt: '2026-10-09T10:00:00.000Z',
        createdAt: '2026-09-01T10:00:00.000Z',
        revokedAt: null,
        disabledAt: null,
        enabled: true,
        ...over,
    };
}

const OLD = record({
    id: 'tok-old', name: 'Old CI', scopes: { studio: { level: 'write', tools: ['studio_list', 'studio_get'] } },
    ipAllowlist: [], expiresAt: null, lastUsedAt: null, revokedAt: '2026-09-20T10:00:00.000Z',
});

let api: ReturnType<typeof fakeBackend>;
beforeEach(() => {
    api = fakeBackend(fetchMock);
    api.on('GET', PATH, { body: { tokens: [record(), OLD], legacy: { exists: false } } });
});

async function renderLoaded() {
    const user = userEvent.setup();
    render(withQueryClient(<McpTokensPanel />));
    await screen.findByText('Claude Code laptop');
    return user;
}

const row = (name: string) => screen.getByText(name).closest('li') as HTMLElement;

it('lists each token with its servers and levels, tool limits, addresses, expiry and last use', async () => {
    await renderLoaded();
    const live = within(row('Claude Code laptop'));
    expect(live.getByText('Integrations: read only')).toBeInTheDocument();
    expect(live.getByText('Website (CMS): read and write, may publish')).toBeInTheDocument();
    expect(live.getByText('Allowed from 203.0.113.0/24')).toBeInTheDocument();
    expect(live.getByText(/Expires /)).toBeInTheDocument();
    expect(live.getByText(/Last used /)).toBeInTheDocument();
    expect(live.queryByText('Revoked')).not.toBeInTheDocument();

    const old = within(row('Old CI'));
    expect(old.getByText('Revoked')).toBeInTheDocument();
    expect(old.getByText('Studio: only studio_list, studio_get')).toBeInTheDocument();
    expect(old.getByText('Any address your organisation allows')).toBeInTheDocument();
    expect(old.getByText(/No expiry/)).toBeInTheDocument();
    expect(old.getByText(/Never used/)).toBeInTheDocument();
    // A revoked token has nothing left to revoke.
    expect(old.queryByRole('button', { name: /Revoke/ })).not.toBeInTheDocument();
});

it('says so when there are no tokens, and shows the legacy notice only when a legacy token exists', async () => {
    api.on('GET', PATH, { body: { tokens: [], legacy: { exists: true } } });
    render(withQueryClient(<McpTokensPanel />));
    expect(await screen.findByText('You have no MCP tokens yet.')).toBeInTheDocument();
    expect(screen.getByText('Legacy token')).toBeInTheDocument();
});

it('shows no legacy notice when there is none', async () => {
    await renderLoaded();
    expect(screen.queryByText('Legacy token')).not.toBeInTheDocument();
});

it('shows why the list could not be loaded, and loads it again on request', async () => {
    api.on('GET', PATH, { status: 500, body: { error: 'internal', code: 'internal', message: 'The token store is down.' } });
    const user = userEvent.setup();
    render(withQueryClient(<McpTokensPanel />));
    expect(await screen.findByRole('alert')).toHaveTextContent('The token store is down.');
    api.on('GET', PATH, { body: { tokens: [record()], legacy: { exists: false } } });
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Claude Code laptop')).toBeInTheDocument();
});

type Form = ReturnType<typeof within>;
type User = ReturnType<typeof userEvent.setup>;

async function openCreate(user: User): Promise<Form> {
    await user.click(screen.getByRole('button', { name: 'Create token' }));
    return within(await screen.findByRole('dialog', { name: 'Create an MCP token' }));
}

/** Integrations (write, three tools) and the website (write, may publish), two networks, 30 days. */
async function fillFullForm(user: User, form: Form) {
    await user.type(form.getByLabelText('Name'), '  Cursor  ');
    await user.click(form.getByRole('checkbox', { name: 'Integrations' }));
    await user.click(within(form.getByRole('group', { name: 'Integrations' })).getByRole('radio', { name: 'Read and write' }));
    await user.type(form.getByLabelText('Only these tools for Integrations (optional)'), 'search_files, read_file{enter}list_files');
    await user.click(form.getByRole('checkbox', { name: 'Website (CMS)' }));
    const cms = within(form.getByRole('group', { name: 'Website (CMS)' }));
    // Publishing needs write access: the box is disabled on read.
    expect(cms.getByRole('checkbox', { name: /May publish the website/ })).toBeDisabled();
    await user.click(cms.getByRole('radio', { name: 'Read and write' }));
    await user.click(cms.getByRole('checkbox', { name: /May publish the website/ }));
    expect(form.getByText(/Publishing puts changes on the live website/)).toBeInTheDocument();
    await user.type(form.getByLabelText('Allowed IP addresses (optional)'), '203.0.113.0/24{enter}2001:db8::/32');
    await user.selectOptions(form.getByLabelText('Expires'), '30');
}

it('sends exactly what the form says', async () => {
    api.on('POST', PATH, { status: 201, body: { token: 'bfmcp_abc_secret123', record: record({ id: 'tok-new' }) } });
    const user = await renderLoaded();
    const form = await openCreate(user);
    await fillFullForm(user, form);
    await user.click(form.getByRole('button', { name: 'Create token' }));

    const body = (await waitFor(() => {
        const b = api.bodies('POST', PATH);
        expect(b).toHaveLength(1);
        return b[0];
    })) as { name: string; scopes: unknown; ipAllowlist: string[]; expiresAt: string };
    expect(body.name).toBe('Cursor');
    expect(body.scopes).toEqual({
        integrations: { level: 'write', tools: ['search_files', 'read_file', 'list_files'] },
        cms: { level: 'write', publish: true },
    });
    expect(body.ipAllowlist).toEqual(['203.0.113.0/24', '2001:db8::/32']);
    const days = (new Date(body.expiresAt).getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(29.9);
    expect(days).toBeLessThan(30.1);
});

it('shows the secret once, with a ready command for exactly the servers granted, and forgets it on Done', async () => {
    api.on('POST', PATH, { status: 201, body: { token: 'bfmcp_abc_secret123', record: record({ id: 'tok-new', name: 'New one' }) } });
    const user = await renderLoaded();
    const form = await openCreate(user);
    await user.type(form.getByLabelText('Name'), 'New one');
    await user.click(form.getByRole('checkbox', { name: 'Integrations' }));
    await user.click(form.getByRole('checkbox', { name: 'Website (CMS)' }));
    await user.click(form.getByRole('button', { name: 'Create token' }));

    const reveal = await screen.findByRole('dialog', { name: 'Your new token' });
    expect(within(reveal).getByLabelText('Token')).toHaveValue('bfmcp_abc_secret123');
    expect(within(reveal).getByText(/shown only once/)).toBeInTheDocument();
    expect(within(reveal).getAllByText(/^claude mcp add --transport http /)).toHaveLength(2);
    expect(within(reveal).getByText(/claude mcp add --transport http beeflow-cms .*\/mcp\/cms --header "Authorization: Bearer bfmcp_abc_secret123"/)).toBeInTheDocument();
    expect(within(reveal).getByText(/claude mcp add --transport http beeflow .*\/mcp --header/)).toBeInTheDocument();
    expect(within(reveal).queryByText(/beeflow-studio/)).not.toBeInTheDocument();

    await user.click(within(reveal).getByRole('button', { name: 'Copy' }));
    expect(await navigator.clipboard.readText()).toBe('bfmcp_abc_secret123');
    await user.click(within(reveal).getByRole('button', { name: 'Copy command for Website (CMS)' }));
    expect(await navigator.clipboard.readText()).toContain('/mcp/cms');

    // Done closes it and the secret is gone from the page for good.
    await user.click(within(reveal).getByRole('button', { name: 'Done' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(document.body.innerHTML).not.toContain('bfmcp_abc_secret123');
});

it('asks for a name, a server and valid addresses before it sends anything', async () => {
    const user = await renderLoaded();
    await user.click(screen.getByRole('button', { name: 'Create token' }));
    const form = within(await screen.findByRole('dialog', { name: 'Create an MCP token' }));

    await user.type(form.getByLabelText('Allowed IP addresses (optional)'), '10.0.0.0/8 nonsense');
    expect(form.getByText('Not a valid address or range: nonsense')).toBeInTheDocument();
    await user.click(form.getByRole('button', { name: 'Create token' }));
    expect(form.getByText('Give the token a name.')).toBeInTheDocument();
    expect(form.getByText('Switch on at least one server.')).toBeInTheDocument();
    expect(api.bodies('POST', PATH)).toHaveLength(0);
});

it('shows the server\'s reason when creating fails, and keeps the form', async () => {
    api.on('POST', PATH, { status: 400, body: { error: 'invalid_scopes', code: 'invalid_scopes', message: 'You cannot use the CMS server.' } });
    const user = await renderLoaded();
    await user.click(screen.getByRole('button', { name: 'Create token' }));
    const form = within(await screen.findByRole('dialog', { name: 'Create an MCP token' }));
    await user.type(form.getByLabelText('Name'), 'X');
    await user.click(form.getByRole('checkbox', { name: 'Studio' }));
    await user.click(form.getByRole('button', { name: 'Create token' }));
    expect(await form.findByRole('alert')).toHaveTextContent('You cannot use the CMS server.');
    expect(form.getByLabelText('Name')).toHaveValue('X');
});

it('revokes a token only after the confirm dialog, and not when it is cancelled', async () => {
    api.on('DELETE', `${PATH}/tok-1`, { status: 204, body: undefined });
    const user = await renderLoaded();

    await user.click(screen.getByRole('button', { name: 'Revoke Claude Code laptop' }));
    let confirm = await screen.findByRole('dialog', { name: 'Revoke "Claude Code laptop"?' });
    await user.click(within(confirm).getByRole('button', { name: 'Cancel' }));
    expect(api.bodies('DELETE', `${PATH}/tok-1`)).toHaveLength(0);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    api.on('GET', PATH, { body: { tokens: [record({ revokedAt: '2026-10-10T08:00:00.000Z' }), OLD], legacy: { exists: false } } });
    await user.click(screen.getByRole('button', { name: 'Revoke Claude Code laptop' }));
    confirm = await screen.findByRole('dialog', { name: 'Revoke "Claude Code laptop"?' });
    await user.click(within(confirm).getByRole('button', { name: 'Revoke token' }));

    await waitFor(() => expect(api.sent.filter(s => s.method === 'DELETE')).toHaveLength(1));
    // The list is read again and the token now reads as revoked.
    await waitFor(() => expect(within(row('Claude Code laptop')).getByText('Revoked')).toBeInTheDocument());
});

const ELIGIBLE = {
    policy: { allowed: true },
    integrations: { available: true },
    automations: { available: true },
    studio: { available: true, canWrite: true },
    cms: { available: true, canPublish: true },
};

function listWith(extra: Record<string, unknown>) {
    api.on('GET', PATH, { body: { tokens: [record(), OLD], legacy: { exists: false }, eligibility: ELIGIBLE, ...extra } });
}

it('switches a token off at once, sends the PATCH, and shows the Uitgeschakeld-style badge', async () => {
    api.on('PATCH', `${PATH}/tok-1`, { body: { record: record({ enabled: false, disabledAt: '2026-10-10T14:00:00.000Z' }) } });
    const user = await renderLoaded();
    const live = within(row('Claude Code laptop'));
    expect(live.queryByText('Switched off')).not.toBeInTheDocument();
    const toggle = live.getByRole('checkbox', { name: 'Token Claude Code laptop on or off' });
    expect(toggle).toBeChecked();

    api.on('GET', PATH, { body: { tokens: [record({ enabled: false, disabledAt: '2026-10-10T14:00:00.000Z' }), OLD], legacy: { exists: false } } });
    await user.click(toggle);

    await waitFor(() => expect(api.bodies('PATCH', `${PATH}/tok-1`)).toEqual([{ enabled: false }]));
    expect(await within(row('Claude Code laptop')).findByText('Switched off')).toBeInTheDocument();
    expect(within(row('Claude Code laptop')).getByRole('checkbox', { name: 'Token Claude Code laptop on or off' })).not.toBeChecked();
});

it('switches a token back on', async () => {
    const off = record({ enabled: false, disabledAt: '2026-10-10T14:00:00.000Z' });
    api.on('GET', PATH, { body: { tokens: [off], legacy: { exists: false } } });
    api.on('PATCH', `${PATH}/tok-1`, { body: { record: record() } });
    const user = await renderLoaded();
    expect(within(row('Claude Code laptop')).getByText('Switched off')).toBeInTheDocument();
    api.on('GET', PATH, { body: { tokens: [record()], legacy: { exists: false } } });
    await user.click(within(row('Claude Code laptop')).getByRole('checkbox', { name: 'Token Claude Code laptop on or off' }));
    await waitFor(() => expect(api.bodies('PATCH', `${PATH}/tok-1`)).toEqual([{ enabled: true }]));
    await waitFor(() => expect(within(row('Claude Code laptop')).queryByText('Switched off')).not.toBeInTheDocument());
});

it('rolls the switch back when the server refuses', async () => {
    api.on('PATCH', `${PATH}/tok-1`, { status: 500, body: { error: 'internal', code: 'internal', message: 'Could not save.' } });
    const user = await renderLoaded();
    await user.click(within(row('Claude Code laptop')).getByRole('checkbox', { name: 'Token Claude Code laptop on or off' }));
    await waitFor(() => expect(api.bodies('PATCH', `${PATH}/tok-1`)).toHaveLength(1));
    await waitFor(() => expect(within(row('Claude Code laptop')).getByRole('checkbox', { name: 'Token Claude Code laptop on or off' })).toBeChecked());
    expect(within(row('Claude Code laptop')).queryByText('Switched off')).not.toBeInTheDocument();
});

it('gives a revoked token no switch', async () => {
    await renderLoaded();
    expect(within(row('Old CI')).queryByRole('checkbox')).not.toBeInTheDocument();
});

it('does not offer a server the operator has not switched on, and disables one the user lacks access to', async () => {
    listWith({ eligibility: {
        ...ELIGIBLE,
        automations: { available: false, reason: 'not_enabled' },
        studio: { available: false, reason: 'no_access', canWrite: false },
    } });
    const user = await renderLoaded();
    const form = await openCreate(user);
    expect(form.queryByRole('checkbox', { name: 'Automations' })).not.toBeInTheDocument();
    const studio = within(form.getByRole('group', { name: 'Studio' }));
    expect(studio.getByRole('checkbox', { name: 'Studio' })).toBeDisabled();
    expect(studio.getByText("You don't have access to this yourself, so a token can't either.")).toBeInTheDocument();
    expect(form.getByRole('checkbox', { name: 'Integrations' })).toBeEnabled();
});

it('only lets the website token publish when the user may publish', async () => {
    listWith({ eligibility: { ...ELIGIBLE, cms: { available: true, canPublish: false } } });
    const user = await renderLoaded();
    const form = await openCreate(user);
    await user.click(form.getByRole('checkbox', { name: 'Website (CMS)' }));
    const cms = within(form.getByRole('group', { name: 'Website (CMS)' }));
    await user.click(cms.getByRole('radio', { name: 'Read and write' }));
    expect(cms.getByRole('checkbox', { name: /May publish the website/ })).toBeDisabled();
});

it('disables Create token and says why when the organisation does not allow MCP for the user', async () => {
    listWith({ eligibility: { ...ELIGIBLE, policy: { allowed: false, reason: 'user_not_allowed' } } });
    await renderLoaded();
    expect(screen.getByRole('button', { name: 'Create token' })).toBeDisabled();
    expect(screen.getByText(/Your organisation does not allow you to use MCP/)).toBeInTheDocument();
});

it('builds the claude mcp add line from the base URL the server reports', async () => {
    listWith({ mcpBaseUrl: 'https://flow.example.org' });
    api.on('POST', PATH, { status: 201, body: { token: 'bfmcp_abc_secret123', record: record({ id: 'tok-new', scopes: { cms: { level: 'read', publish: false } } }) } });
    const user = await renderLoaded();
    const form = await openCreate(user);
    await user.type(form.getByLabelText('Name'), 'Site');
    await user.click(form.getByRole('checkbox', { name: 'Website (CMS)' }));
    await user.click(form.getByRole('button', { name: 'Create token' }));
    const reveal = await screen.findByRole('dialog', { name: 'Your new token' });
    expect(within(reveal).getByText(/claude mcp add --transport http beeflow-cms https:\/\/flow\.example\.org\/mcp\/cms /)).toBeInTheDocument();
});

it('warns on a token whose server its owner has lost access to', async () => {
    listWith({ eligibility: { ...ELIGIBLE, cms: { available: false, reason: 'no_access', canPublish: false } } });
    await renderLoaded();
    expect(within(row('Claude Code laptop')).getByText('You no longer have access to Website (CMS), so this token cannot use it.')).toBeInTheDocument();
});
