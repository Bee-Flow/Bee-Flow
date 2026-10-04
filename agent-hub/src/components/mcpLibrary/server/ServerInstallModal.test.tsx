// The server administrator's install dialog. A local (stdio) server is a
// program this Bee Flow server downloads and runs, so anything not from the
// curated library asks before it is installed; the curated library does not.

import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, it, vi } from 'vitest';
import type { ServerMcpServer } from '../../../api/queries/serverMcp';
import { fakeBackend } from '@/test/mcpLibraryKit';
import { withQueryClient } from '@/test/queryWrapper';
import ServerInstallModal from './ServerInstallModal';

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));
vi.mock('../../../utils/helpers', async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    API_BASE: '',
    authFetch: fetchMock,
}));

const SERVERS = '/ai/mcp-servers';
const RUN_CONFIRM = 'Run this program on your server?';

let api: ReturnType<typeof fakeBackend>;
beforeEach(() => {
    api = fakeBackend(fetchMock);
    api.on('POST', SERVERS, (body) => ({ body: { server: { id: 'new', name: (body as { name: string }).name, enabled: true } } }));
});

function renderModal(installed: ServerMcpServer[] = []) {
    const user = userEvent.setup();
    render(withQueryClient(<ServerInstallModal installed={installed} onClose={vi.fn()} />));
    return user;
}

const rowOf = (name: string) => screen.getByText(name, { selector: 'span' }).closest('li') as HTMLElement;

it('installs a curated library entry at once, with its exact command and credentials', async () => {
    const user = renderModal();
    await user.type(screen.getByRole('searchbox', { name: 'Search servers' }), 'github');
    const github = rowOf('GitHub');
    expect(github).toHaveTextContent('npx -y @modelcontextprotocol/server-github');
    await user.click(within(github).getByRole('button', { name: 'Install' }));

    expect(screen.queryByRole('dialog', { name: RUN_CONFIRM })).not.toBeInTheDocument();
    const [body] = api.bodies('POST', SERVERS);
    expect(body).toMatchObject({
        name: 'GitHub',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-github'],
        url: null,
        category: 'development',
        required_credentials: [{ key: 'GITHUB_PERSONAL_ACCESS_TOKEN', label: 'GitHub PAT' }],
    });
});

it('an entry that is already installed shows "Installed" instead of a button', async () => {
    const user = renderModal([{ id: 'github', name: 'GitHub', enabled: true }]);
    await user.type(screen.getByRole('searchbox', { name: 'Search servers' }), 'github');
    const github = rowOf('GitHub');
    expect(within(github).getByText('Installed')).toBeInTheDocument();
    expect(within(github).queryByRole('button', { name: 'Install' })).not.toBeInTheDocument();
});

/** The Custom tab, filled in for a program to run on this server. */
async function fillCustomStdio(user: ReturnType<typeof userEvent.setup>) {
    await user.click(screen.getByRole('tab', { name: 'Custom' }));
    await user.type(screen.getByLabelText('Name'), 'Acme tools');
    await user.type(screen.getByLabelText('Command'), 'npx');
    await user.type(screen.getByLabelText('Arguments'), '-y  @acme/mcp-server@1.2.3');
    await user.type(screen.getByLabelText('Keys each member provides (optional)'), 'ACME_KEY, ');
}

it('a custom program asks first, naming the command; cancelling installs nothing', async () => {
    const user = renderModal();
    await fillCustomStdio(user);
    await user.click(screen.getByRole('button', { name: 'Install' }));

    const ask = screen.getByRole('dialog', { name: RUN_CONFIRM });
    expect(ask).toHaveTextContent('Installing downloads and starts "npx -y @acme/mcp-server@1.2.3" on this Bee Flow server');
    await user.click(within(ask).getByRole('button', { name: 'Cancel' }));
    expect(api.bodies('POST', SERVERS)).toEqual([]);
});

it('a confirmed custom program is installed with its arguments split and its member keys listed', async () => {
    const user = renderModal();
    await fillCustomStdio(user);
    await user.click(screen.getByRole('button', { name: 'Install' }));
    await user.click(within(screen.getByRole('dialog', { name: RUN_CONFIRM })).getByRole('button', { name: 'Install and run' }));

    const [body] = api.bodies('POST', SERVERS);
    expect(body).toMatchObject({
        name: 'Acme tools',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@acme/mcp-server@1.2.3'],
        category: 'development',
        required_credentials: [{ key: 'ACME_KEY', label: 'ACME_KEY' }],
        source: 'manual',
    });
});

it('a custom remote server runs nowhere here, so it installs without the program warning', async () => {
    const user = renderModal();
    await user.click(screen.getByRole('tab', { name: 'Custom' }));
    await user.click(screen.getByRole('radio', { name: 'Remote (https address)' }));
    await user.type(screen.getByLabelText('Name'), 'Desk');
    await user.type(screen.getByLabelText('Server address'), 'https://mcp.desk.example/mcp');
    await user.click(screen.getByRole('button', { name: 'Install' }));

    expect(screen.queryByRole('dialog', { name: RUN_CONFIRM })).not.toBeInTheDocument();
    expect(api.bodies('POST', SERVERS)).toEqual([expect.objectContaining({ name: 'Desk', transport: 'http', url: 'https://mcp.desk.example/mcp', args: [] })]);
});

it('a custom server under the name of an installed one asks before replacing it', async () => {
    const user = renderModal([{ id: 'desk', name: 'Desk', enabled: true }]);
    await user.click(screen.getByRole('tab', { name: 'Custom' }));
    await user.click(screen.getByRole('radio', { name: 'Remote (https address)' }));
    await user.type(screen.getByLabelText('Name'), 'Desk');
    await user.type(screen.getByLabelText('Server address'), 'https://mcp.desk.example/mcp');
    await user.click(screen.getByRole('button', { name: 'Install' }));

    const ask = screen.getByRole('dialog', { name: 'A server named "Desk" is already installed' });
    await user.click(within(ask).getByRole('button', { name: 'Cancel' }));
    expect(api.bodies('POST', SERVERS)).toEqual([]);
});

it('a program from the open registry asks first too, and is installed tagged as from the registry', async () => {
    api.on('GET', '/ai/mcp-registry/search', { body: { servers: [{ name: 'Weather', description: 'Forecasts', transport: 'stdio', command: 'npx', args: ['-y', 'weather-mcp@0.1.0'] }], nextCursor: null } });
    const user = renderModal();
    await user.click(screen.getByRole('tab', { name: 'MCP registry' }));
    await screen.findByText('Weather', { selector: 'span' });
    await user.click(within(rowOf('Weather')).getByRole('button', { name: 'Install' }));
    await user.click(within(screen.getByRole('dialog', { name: RUN_CONFIRM })).getByRole('button', { name: 'Install and run' }));

    expect(api.bodies('POST', SERVERS)).toEqual([expect.objectContaining({ name: 'Weather', command: 'npx', source: 'registry' })]);
});

it('a refused install says why', async () => {
    api.on('POST', SERVERS, { status: 403, body: { error: 'Only a server administrator can install MCP servers.' } });
    const user = renderModal();
    await user.type(screen.getByRole('searchbox', { name: 'Search servers' }), 'github');
    await user.click(within(rowOf('GitHub')).getByRole('button', { name: 'Install' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Only a server administrator can install MCP servers.');
});
