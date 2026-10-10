// Organisation → MCP access: the policy form (enabled, networks, who may use
// MCP, legacy tokens), the lockout warning when the admin's own address is not
// in the list, client-side validation of the list, and saving.

import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, it, vi } from 'vitest';
import { DEFAULT_MCP_POLICY } from '../../api/queries/mcpAccess';
import type { McpAccessPolicy } from '../../api/queries/mcpAccess';
import { fakeBackend } from '@/test/mcpLibraryKit';
import { withQueryClient } from '@/test/queryWrapper';
import OrgMcpAccessPanel from './OrgMcpAccessPanel';

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));
vi.mock('../../utils/helpers', async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    API_BASE: '',
    authFetch: fetchMock,
}));

const PATH = '/api/org/mcp-access';
const CALLER = '198.51.100.7';

let api: ReturnType<typeof fakeBackend>;

function serve(policy: Partial<McpAccessPolicy> = {}, callerIp: string | null = CALLER) {
    api.on('GET', PATH, { body: { policy: { ...DEFAULT_MCP_POLICY, ...policy }, callerIp } });
    api.on('PUT', PATH, (body) => ({ body: { policy: body } }));
}

beforeEach(() => { api = fakeBackend(fetchMock); });

async function renderLoaded() {
    const user = userEvent.setup();
    render(withQueryClient(<OrgMcpAccessPanel />));
    await screen.findByRole('checkbox', { name: 'Allow MCP access' });
    return user;
}

const networks = () => screen.getByLabelText('Allowed networks') as HTMLTextAreaElement;
const save = () => screen.getByRole('button', { name: 'Save' });

it('shows the stored policy and keeps Save off until something changes', async () => {
    serve({ ipAllowlist: ['203.0.113.0/24', '2001:db8::/32'], allowedUsers: { mode: 'roles', roles: ['org_admin'], userIds: [] }, rejectLegacyTokens: true });
    await renderLoaded();
    expect(screen.getByRole('checkbox', { name: 'Allow MCP access' })).toBeChecked();
    expect(networks()).toHaveValue('203.0.113.0/24\n2001:db8::/32');
    expect(screen.getByRole('radio', { name: 'Specific roles' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Organisation Admin' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Refuse legacy tokens' })).toBeChecked();
    expect(save()).toBeDisabled();
});

it('warns that the admin would lock themselves out of MCP, and says the web app is not affected', async () => {
    serve({ ipAllowlist: [] });
    const user = await renderLoaded();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByText(`Your current address is ${CALLER}.`)).toBeInTheDocument();

    await user.type(networks(), '203.0.113.0/24');
    const warning = await screen.findByRole('alert');
    expect(warning).toHaveTextContent(`Your current address (${CALLER}) is not in this list`);
    expect(warning).toHaveTextContent('lock yourself out of MCP from this network');
    expect(warning).toHaveTextContent('The web app is not affected');

    // Adding the address (or a range that holds it) clears the warning.
    await user.click(screen.getByRole('button', { name: 'Add my address' }));
    expect(networks()).toHaveValue(`203.0.113.0/24\n${CALLER}`);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add my address' })).not.toBeInTheDocument();
});

it('does not warn when the address is inside a range, or when MCP is off, or when the list is empty', async () => {
    serve({ ipAllowlist: ['198.51.100.0/24'] });
    const user = await renderLoaded();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    await user.clear(networks());
    await user.type(networks(), '203.0.113.0/24');
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    await user.click(screen.getByRole('checkbox', { name: 'Allow MCP access' }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    await user.click(screen.getByRole('checkbox', { name: 'Allow MCP access' }));
    await user.clear(networks());
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

it('does not warn when the server could not tell the caller\'s address', async () => {
    serve({ ipAllowlist: ['203.0.113.0/24'] }, null);
    await renderLoaded();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByText(/Your current address is/)).not.toBeInTheDocument();
});

it('names an entry that is not an address or range and will not save it', async () => {
    serve();
    const user = await renderLoaded();
    await user.type(networks(), `${CALLER}\n10.0.0.0/99 and-more`);
    expect(screen.getByText('Not a valid address or range: 10.0.0.0/99, and-more')).toBeInTheDocument();
    expect(save()).toBeDisabled();
    expect(api.bodies('PUT', PATH)).toHaveLength(0);
});

it('saves the policy and goes back to a clean form', async () => {
    serve();
    const user = await renderLoaded();
    await user.type(networks(), `${CALLER}\n203.0.113.0/24`);
    await user.click(screen.getByRole('radio', { name: 'Specific roles' }));
    await user.click(screen.getByRole('checkbox', { name: 'Organisation Admin' }));
    await user.click(screen.getByRole('checkbox', { name: 'Refuse legacy tokens' }));
    await user.click(save());

    await waitFor(() => expect(api.bodies('PUT', PATH)).toHaveLength(1));
    expect(api.bodies('PUT', PATH)[0]).toEqual({
        enabled: true,
        ipAllowlist: [CALLER, '203.0.113.0/24'],
        allowedUsers: { mode: 'roles', roles: ['org_admin'], userIds: [] },
        rejectLegacyTokens: true,
    });
    await waitFor(() => expect(save()).toBeDisabled());
    expect(networks()).toHaveValue(`${CALLER}\n203.0.113.0/24`);
});

it('picks specific members from the organisation and sends their ids only', async () => {
    serve();
    api.on('GET', '/auth/users', { body: [
        { id: 'u1', displayName: 'Ada Lovelace', email: 'ada@example.com' },
        { id: 'u2', username: 'grace', email: 'grace@example.com' },
    ] });
    const user = await renderLoaded();
    await user.click(screen.getByRole('radio', { name: 'Specific members' }));
    expect(await screen.findByText('Ada Lovelace')).toBeInTheDocument();
    expect(screen.getByText('Nobody is selected, so nobody could use MCP.')).toBeInTheDocument();

    await user.type(screen.getByRole('searchbox', { name: 'Search members' }), 'grace');
    expect(screen.queryByText('Ada Lovelace')).not.toBeInTheDocument();
    await user.click(within(screen.getByText('grace').closest('label') as HTMLElement).getByRole('checkbox'));
    expect(screen.queryByText('Nobody is selected, so nobody could use MCP.')).not.toBeInTheDocument();
    await user.click(save());

    await waitFor(() => expect(api.bodies('PUT', PATH)).toHaveLength(1));
    expect(api.bodies('PUT', PATH)[0]).toMatchObject({ allowedUsers: { mode: 'users', roles: [], userIds: ['u2'] } });
});

it('shows the server\'s reason when saving fails and keeps the edits', async () => {
    serve();
    api.on('PUT', PATH, { status: 403, body: { error: 'forbidden', code: 'not_org_admin', message: 'Only an organisation admin can change MCP access.' } });
    const user = await renderLoaded();
    await user.click(screen.getByRole('checkbox', { name: 'Refuse legacy tokens' }));
    await user.click(save());
    expect(await screen.findByRole('alert')).toHaveTextContent('Only an organisation admin can change MCP access.');
    expect(screen.getByRole('checkbox', { name: 'Refuse legacy tokens' })).toBeChecked();
    expect(save()).toBeEnabled();
});

it('says why the policy could not be loaded', async () => {
    api.on('GET', PATH, { status: 403, body: { error: 'forbidden', code: 'not_org_admin', message: 'Only an organisation admin can open MCP access.' } });
    render(withQueryClient(<OrgMcpAccessPanel />));
    expect(await screen.findByRole('alert')).toHaveTextContent('Only an organisation admin can open MCP access.');
});
