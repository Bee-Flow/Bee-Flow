// The install wizard: connect (and prove it), choose tools, choose access,
// install. What is pinned is the contract with the server: the probe asks
// about exactly what will be installed (a library id, never an address it
// could be pointed elsewhere with), a changed key needs a new check, and the
// install body carries the choices of every step.

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, it, vi } from 'vitest';
import type { CatalogEntry } from '../../api/queries/mcpLibrary';
import {
    catalogEntry, fakeBackend, GROUPS, installedServer, tool,
} from '@/test/mcpLibraryKit';
import { withQueryClient } from '@/test/queryWrapper';
import InstallWizard from './InstallWizard';

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));
vi.mock('../../utils/helpers', async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    API_BASE: '',
    authFetch: fetchMock,
}));

const PROBE = '/api/mcp-library/org/probe';
const INSTALL = '/api/mcp-library/org/servers';
const TOOLS = [
    tool('list_issues', { readOnly: true }),
    tool('create_issue', { readOnly: false }),
    tool('delete_issue', { readOnly: false, destructive: true }),
];

let api: ReturnType<typeof fakeBackend>;
beforeEach(() => {
    api = fakeBackend(fetchMock);
    api.on('POST', PROBE, { body: { url: 'https://mcp.linear.app/mcp', tools: TOOLS, warnings: [] } });
    api.on('POST', INSTALL, { body: { server: installedServer({ id: 'srv-linear', name: 'Linear', catalogId: 'linear', enabledToolCount: 2 }) } });
});

function renderWizard(entry: CatalogEntry | null = catalogEntry()) {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const onOpenInstalled = vi.fn();
    render(withQueryClient(<InstallWizard entry={entry} groups={GROUPS} onClose={onClose} onOpenInstalled={onOpenInstalled} />));
    return { user, onClose, onOpenInstalled };
}

type User = ReturnType<typeof userEvent.setup>;
const next = () => screen.getByRole('button', { name: 'Next' });
const checkConnection = () => screen.getByRole('button', { name: 'Check connection' });

/** Step 1 for the Linear entry: paste the key and pass the check. */
async function connect(user: User, key = 'lin_api_123') {
    await user.type(screen.getByLabelText('Linear API key'), key);
    await user.click(checkConnection());
    await screen.findByText(/^Connected · /);
}

it('step 1 of a library entry: the official endpoint is fixed, and Next waits for a passing check', async () => {
    const { user } = renderWizard();
    const dialog = screen.getByRole('dialog', { name: 'Add Linear' });
    expect(dialog).toHaveTextContent('Step 1 of 3 · Connect');
    expect(dialog).toHaveTextContent('Runs at mcp.linear.app, operated by Linear.');
    expect(screen.queryByLabelText('Server address')).not.toBeInTheDocument();
    expect(next()).toBeDisabled();

    await user.type(screen.getByLabelText('Linear API key'), '  lin_api_123  ');
    expect(next()).toBeDisabled();
    await user.click(checkConnection());

    expect(await screen.findByRole('status')).toHaveTextContent('Connected · 3 tools');
    expect(next()).toBeEnabled();
    // The library id and the (trimmed) key: no url, no auth style to override.
    expect(api.bodies('POST', PROBE)).toEqual([{ catalogId: 'linear', credential: 'lin_api_123' }]);
});

it('a key changed after a passing check takes Next away again; the checked key brings it back without a new probe', async () => {
    const { user } = renderWizard();
    await connect(user);
    expect(next()).toBeEnabled();

    await user.type(screen.getByLabelText('Linear API key'), 'X');
    expect(next()).toBeDisabled();
    expect(screen.queryByText(/^Connected · /)).not.toBeInTheDocument();

    await user.type(screen.getByLabelText('Linear API key'), '{Backspace}');
    expect(next()).toBeEnabled();
    expect(api.bodies('POST', PROBE)).toHaveLength(1);
});

it('a refused key shows the translated sentence for its code, and Next stays off', async () => {
    api.on('POST', PROBE, { status: 422, body: { error: 'Upstream answered 401 Unauthorized.', code: 'connect_auth_failed' } });
    const { user } = renderWizard();
    await user.type(screen.getByLabelText('Linear API key'), 'wrong');
    await user.click(checkConnection());

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('The server refused the key. Check that it is correct and has the right permissions.');
    expect(alert).not.toHaveTextContent('401');
    expect(next()).toBeDisabled();
});

it('a failure without a known code shows the server\'s own sentence', async () => {
    api.on('POST', PROBE, { status: 502, body: { error: 'Linear is down for maintenance.' } });
    const { user } = renderWizard();
    await user.type(screen.getByLabelText('Linear API key'), 'k');
    await user.click(checkConnection());
    expect(await screen.findByRole('alert')).toHaveTextContent('Linear is down for maintenance.');
    // A probe is never replayed behind the admin's back.
    expect(api.bodies('POST', PROBE)).toHaveLength(1);
});

it('step 2 preselects every tool except the ones the server calls destructive', async () => {
    const { user } = renderWizard();
    await connect(user);
    await user.click(next());

    expect(screen.getByRole('dialog')).toHaveTextContent('Step 2 of 3 · Tools');
    expect(screen.getByRole('checkbox', { name: /^list_issues/ })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: /^create_issue/ })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: /^delete_issue/ })).not.toBeChecked();
    expect(screen.getByText('2 of 3 switched on')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'None' }));
    expect(next()).toBeDisabled();
});

it('step 3 with groups needs at least one group; Install posts every choice; the last step says it is ready', async () => {
    const { user, onOpenInstalled } = renderWizard();
    await connect(user);
    await user.click(next());
    await user.click(next());
    expect(screen.getByRole('dialog')).toHaveTextContent('Step 3 of 3 · Access');

    const install = screen.getByRole('button', { name: 'Install' });
    expect(install).toBeEnabled();
    await user.click(screen.getByRole('radio', { name: /^Specific groups/ }));
    expect(install).toBeDisabled();
    expect(screen.getByText('Pick at least one group.')).toBeInTheDocument();
    await user.click(screen.getByRole('checkbox', { name: 'Engineering' }));
    expect(install).toBeEnabled();
    expect(screen.getByText('2 tools switched on')).toBeInTheDocument();

    await user.click(install);
    expect(await screen.findByText('Linear is ready')).toBeInTheDocument();
    expect(screen.getByText('2 tools are now available in the chats and agents of the people you chose.')).toBeInTheDocument();
    expect(api.bodies('POST', INSTALL)).toEqual([{
        catalogId: 'linear',
        credential: 'lin_api_123',
        credentialMode: 'shared',
        tools: ['list_issues', 'create_issue'],
        access: { mode: 'groups', groupIds: ['g-eng'] },
    }]);
    await user.click(screen.getByRole('button', { name: 'Open server' }));
    expect(onOpenInstalled).toHaveBeenCalledWith(expect.objectContaining({ id: 'srv-linear' }));
});

it('a refused install stays on the access step with the reason', async () => {
    api.on('POST', INSTALL, { status: 403, body: { error: 'Not allowed.', code: 'policy_not_official' } });
    const { user } = renderWizard();
    await connect(user);
    await user.click(next());
    await user.click(next());
    await user.click(screen.getByRole('button', { name: 'Install' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Only the official servers in the library can be installed on this server.');
    expect(screen.getByRole('dialog')).toHaveTextContent('Step 3 of 3 · Access');
});

it('a self-hosted library entry asks for its address and sends it with the library id', async () => {
    const entry = catalogEntry({ id: 'gitlab_self', name: 'GitLab', url: 'https://gitlab.example.com/api/v4/mcp', host: null, selfHosted: true, credential: { key: 'TOKEN', label: 'GitLab token', help: null, helpUrl: null } });
    const { user } = renderWizard(entry);
    const address = screen.getByLabelText('Server address');
    expect(address).toHaveAttribute('placeholder', 'https://gitlab.example.com/api/v4/mcp');
    await user.type(address, 'https://gitlab.acme.example/api/v4/mcp');
    await user.type(screen.getByLabelText('GitLab token'), 'glpat');
    await user.click(checkConnection());
    await screen.findByText(/^Connected · /);
    expect(api.bodies('POST', PROBE)).toEqual([{ catalogId: 'gitlab_self', url: 'https://gitlab.acme.example/api/v4/mcp', credential: 'glpat' }]);
});

/** Step 1 of a custom server with a key in a named header, each member's own. */
async function connectCustom(user: User) {
    await user.type(screen.getByLabelText('Name'), 'Support desk');
    await user.type(screen.getByLabelText('Server address'), 'https://mcp.desk.example/mcp');
    expect(screen.queryByLabelText('API key or token')).not.toBeInTheDocument();
    await user.click(screen.getByRole('radio', { name: 'Key in a header' }));
    await user.type(screen.getByLabelText('Header name'), 'X-Api-Key');
    await user.click(screen.getByRole('radio', { name: /^Everyone uses their own key/ }));
    await user.type(screen.getByLabelText('API key or token'), 'desk-secret');
    await user.click(checkConnection());
    await screen.findByText(/^Connected · /);
}

it('a custom server sends its address and header auth, then installs under its own name with personal keys', async () => {
    api.on('POST', PROBE, { body: { url: 'https://mcp.desk.example/mcp', tools: [tool('search', { readOnly: true }), tool('reply', { readOnly: false })], warnings: [] } });
    api.on('POST', INSTALL, { body: { server: installedServer({ id: 'srv-desk', name: 'Support desk', credentialMode: 'personal', enabledToolCount: 2 }) } });
    const { user } = renderWizard(null);
    expect(screen.getByRole('dialog', { name: 'Connect a server' })).toBeInTheDocument();
    await connectCustom(user);

    const auth = { style: 'header', header: 'X-Api-Key' };
    expect(api.bodies('POST', PROBE)).toEqual([{ url: 'https://mcp.desk.example/mcp', auth, credential: 'desk-secret' }]);

    await user.click(next());
    await user.click(next());
    expect(screen.getByText('Every member connects their own key.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Install' }));

    expect(await screen.findByText('Support desk is ready')).toBeInTheDocument();
    expect(api.bodies('POST', INSTALL)).toEqual([{
        url: 'https://mcp.desk.example/mcp', auth, credential: 'desk-secret', name: 'Support desk',
        credentialMode: 'personal', tools: ['search', 'reply'], access: { mode: 'everyone' },
    }]);
    expect(screen.getByText(/as soon as they add their own key under Settings → Connections\./)).toBeInTheDocument();
});

// The done sentence has its own singular and plural (nOf), so one tool does
// not read "1 tool are now available …".
it('with one tool the done step reads in the singular', async () => {
    api.on('POST', INSTALL, { body: { server: installedServer({ id: 'srv-linear', name: 'Linear', enabledToolCount: 1 }) } });
    const { user } = renderWizard();
    await connect(user);
    await user.click(next());
    await user.click(next());
    await user.click(screen.getByRole('button', { name: 'Install' }));
    await screen.findByText('Linear is ready');
    expect(screen.queryByText(/1 tool are /)).not.toBeInTheDocument();
    expect(screen.getByText('1 tool is now available in the chats and agents of the people you chose.')).toBeInTheDocument();
});
