// Settings → Connections: a member's own key for each MCP server their
// organisation added. Renders nothing without such servers (also when the
// route answers 403/404); otherwise one row per server, and the key goes to
// /api/mcp-library/me/:id/credential.

import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, it, vi } from 'vitest';
import { mcpLibraryKeys } from '../../api/queries/mcpLibrary';
import type { MemberServer } from '../../api/queries/mcpLibrary';
import { fakeBackend } from '@/test/mcpLibraryKit';
import { testQueryClient, withQueryClient } from '@/test/queryWrapper';
import OrgMcpConnections from './OrgMcpConnections';

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));
vi.mock('../../utils/helpers', async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    API_BASE: '',
    authFetch: fetchMock,
}));

const ME = '/api/mcp-library/me';

function member(over: Partial<MemberServer>): MemberServer {
    return {
        id: 'srv-linear',
        name: 'Linear',
        description: '',
        catalogId: 'linear',
        host: 'mcp.linear.app',
        credential: { label: 'Linear API key', help: null, helpUrl: 'https://linear.app/settings/api' },
        sharedKey: false,
        connected: false,
        ...over,
    };
}

const SERVERS = [
    member({}),
    member({ id: 'srv-stripe', name: 'Stripe', host: 'mcp.stripe.com', credential: { label: 'Stripe key', help: 'A restricted key is enough.', helpUrl: null }, sharedKey: true }),
    member({ id: 'srv/sentry', name: 'Sentry', host: 'mcp.sentry.dev', credential: { label: 'Sentry token', help: null, helpUrl: null }, connected: true }),
];

let api: ReturnType<typeof fakeBackend>;
beforeEach(() => {
    api = fakeBackend(fetchMock);
    api.on('GET', ME, { body: { servers: SERVERS } });
    api.on('PUT', `${ME}/srv-linear/credential`, { body: { connected: true } });
    api.on('DELETE', `${ME}/srv%2Fsentry/credential`, { body: { connected: false } });
});

async function renderLoaded() {
    const user = userEvent.setup();
    render(withQueryClient(<OrgMcpConnections />));
    await screen.findByText('MCP servers from your organisation');
    return user;
}

const row = (name: string) => screen.getByText(name, { selector: 'div' }).closest('li') as HTMLElement;

it.each([
    ['no servers', { body: { servers: [] } }],
    ['a 403 (no organisation)', { status: 403, body: { error: 'Forbidden' } }],
    ['a 404 (an older server)', { status: 404, body: { error: 'Not found' } }],
])('renders nothing for %s', async (_label, reply) => {
    api.on('GET', ME, reply);
    const client = testQueryClient();
    const { container } = render(withQueryClient(<OrgMcpConnections />, client));
    // Settled as a success with an empty list: not an error, not still loading.
    await waitFor(() => expect(client.getQueryState(mcpLibraryKeys.me())?.status).toBe('success'));
    expect(client.getQueryData(mcpLibraryKeys.me())).toEqual([]);
    expect(container).toBeEmptyDOMElement();
});

it('shows one row per server with where its key stands', async () => {
    await renderLoaded();
    expect(within(row('Linear')).getByText('Not connected')).toBeInTheDocument();
    expect(within(row('Stripe')).getByText('Organisation key')).toBeInTheDocument();
    expect(within(row('Sentry')).getByText('Your key')).toBeInTheDocument();

    // A server nobody has a key for opens on the field; the others wait for a click.
    expect(within(row('Linear')).getByLabelText('Linear API key')).toBeInTheDocument();
    expect(within(row('Linear')).getByText(/only ever sent to mcp\.linear\.app/)).toBeInTheDocument();
    expect(within(row('Linear')).getByRole('link', { name: 'Create one' })).toHaveAttribute('href', 'https://linear.app/settings/api');
    expect(within(row('Stripe')).getByRole('button', { name: 'Add your key' })).toBeInTheDocument();
    expect(within(row('Sentry')).getByRole('button', { name: 'Replace' })).toBeInTheDocument();
});

it('with a shared organisation key, the field says when an own key is worth adding', async () => {
    const user = await renderLoaded();
    await user.click(within(row('Stripe')).getByRole('button', { name: 'Add your key' }));
    expect(within(row('Stripe')).getByText('A restricted key is enough.')).toBeInTheDocument();
    expect(within(row('Stripe')).getByText(/Your organisation already shares a key\./)).toBeInTheDocument();
});

it('saving a key PUTs the trimmed value to the member route and closes the field', async () => {
    const user = await renderLoaded();
    const linear = row('Linear');
    expect(within(linear).getByRole('button', { name: 'Check and save' })).toBeDisabled();
    await user.type(within(linear).getByLabelText('Linear API key'), '  lin_mine  ');
    await user.click(within(linear).getByRole('button', { name: 'Check and save' }));

    expect(api.bodies('PUT', `${ME}/srv-linear/credential`)).toEqual([{ value: 'lin_mine' }]);
    await waitFor(() => expect(within(linear).queryByLabelText('Linear API key')).not.toBeInTheDocument());
    // The list is read again so the row shows the new state.
    await waitFor(() => expect(api.bodies('GET', ME)).toHaveLength(2));
});

it('Enter in the field saves too', async () => {
    const user = await renderLoaded();
    await user.type(within(row('Linear')).getByLabelText('Linear API key'), 'lin_enter{Enter}');
    expect(api.bodies('PUT', `${ME}/srv-linear/credential`)).toEqual([{ value: 'lin_enter' }]);
});

it('a refused key shows the server\'s sentence and keeps the field', async () => {
    api.on('PUT', `${ME}/srv-linear/credential`, { status: 400, body: { error: 'Linear did not accept this key.' } });
    const user = await renderLoaded();
    const linear = row('Linear');
    await user.type(within(linear).getByLabelText('Linear API key'), 'nope');
    await user.click(within(linear).getByRole('button', { name: 'Check and save' }));
    expect(await within(linear).findByRole('alert')).toHaveTextContent('Linear did not accept this key.');
    expect(within(linear).getByLabelText('Linear API key')).toHaveValue('nope');
});

it('a connected member can remove their own key (the id is encoded in the path)', async () => {
    const user = await renderLoaded();
    const sentry = row('Sentry');
    await user.click(within(sentry).getByRole('button', { name: 'Replace' }));
    await user.click(within(sentry).getByRole('button', { name: 'Remove my key' }));
    expect(api.bodies('DELETE', `${ME}/srv%2Fsentry/credential`)).toEqual([undefined]);
});
