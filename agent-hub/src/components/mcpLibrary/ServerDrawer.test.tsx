// One installed server's drawer: every change an org admin can make, and the
// exact PATCH / PUT / DELETE each one sends. Consequential changes (own keys,
// remove) ask first; a cancelled confirm sends nothing.

import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, it, vi } from 'vitest';
import type { InstalledServer } from '../../api/queries/mcpLibrary';
import {
    deferred, fakeBackend, GROUPS, installedServer,
} from '@/test/mcpLibraryKit';
import type { Reply } from '@/test/mcpLibraryKit';
import { testQueryClient, withQueryClient } from '@/test/queryWrapper';
import ServerDrawer from './ServerDrawer';

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));
vi.mock('../../utils/helpers', async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    API_BASE: '',
    authFetch: fetchMock,
}));

const SERVER = '/api/mcp-library/org/servers/srv-sentry';

let api: ReturnType<typeof fakeBackend>;
beforeEach(() => {
    api = fakeBackend(fetchMock);
    api.on('PATCH', SERVER, { body: { server: installedServer() } });
    api.on('PUT', `${SERVER}/credential`, { body: { ok: true } });
    api.on('DELETE', SERVER, { body: { removed: true } });
});

function renderDrawer(over: Partial<InstalledServer> = {}) {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const client = testQueryClient();
    const ui = (server: InstalledServer) => withQueryClient(<ServerDrawer server={server} catalog={null} groups={GROUPS} onClose={onClose} />, client);
    const { rerender } = render(ui(installedServer(over)));
    return { user, onClose, rerender: (next: Partial<InstalledServer>) => rerender(ui(installedServer(next))) };
}

const drawer = () => screen.getByRole('dialog', { name: 'Sentry' });
const confirmDialog = (name: string) => screen.getByRole('dialog', { name });
const tool = (name: string) => screen.getByRole('checkbox', { name: new RegExp(`^${name}(?![a-z0-9_])`) });

it('switching Running off sends {enabled:false}, and everything else waits while it saves', async () => {
    const gate = deferred<Reply>();
    api.on('PATCH', SERVER, () => gate.promise);
    const { user } = renderDrawer();
    const running = screen.getByRole('checkbox', { name: 'Running' });
    expect(running).toBeChecked();

    await user.click(running);
    expect(api.bodies('PATCH', SERVER)).toEqual([{ enabled: false }]);
    expect(screen.getByRole('button', { name: 'Remove server' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Replace key' })).toBeDisabled();

    gate.resolve({ body: { server: installedServer({ status: 'disabled' }) } });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Remove server' })).toBeEnabled());
});

it('a changed tool selection shows "Save tools", which sends exactly the tools switched on', async () => {
    const { user } = renderDrawer();
    expect(screen.queryByRole('button', { name: 'Save tools' })).not.toBeInTheDocument();
    expect(tool('delete_project')).not.toBeChecked();

    await user.click(tool('update_issue'));
    await user.click(screen.getByRole('button', { name: 'Save tools' }));
    expect(api.bodies('PATCH', SERVER)).toEqual([{ tools: ['list_issues'] }]);
});

it('switching every tool off cannot be saved', async () => {
    const { user } = renderDrawer();
    await user.click(screen.getByRole('button', { name: 'None' }));
    expect(screen.getByRole('button', { name: 'Save tools' })).toBeDisabled();
});

it('a changed access shows "Save access", which needs a group and sends {access}', async () => {
    const { user } = renderDrawer();
    expect(screen.queryByRole('button', { name: 'Save access' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('radio', { name: /^Specific groups/ }));
    const save = screen.getByRole('button', { name: 'Save access' });
    expect(save).toBeDisabled();

    await user.click(screen.getByRole('checkbox', { name: 'Sales' }));
    await user.click(save);
    expect(api.bodies('PATCH', SERVER)).toEqual([{ access: { mode: 'groups', groupIds: ['g-sales'] } }]);
});

it('going back to everyone sends a bare {mode:"everyone"}', async () => {
    const { user } = renderDrawer({ access: { mode: 'groups', groupIds: ['g-eng'] } });
    expect(screen.getByRole('checkbox', { name: 'Engineering' })).toBeChecked();
    await user.click(screen.getByRole('radio', { name: /^Everyone in the organisation/ }));
    await user.click(screen.getByRole('button', { name: 'Save access' }));
    expect(api.bodies('PATCH', SERVER)).toEqual([{ access: { mode: 'everyone' } }]);
});

it('"Switch to own keys" asks first: cancel sends nothing, confirm sends {credentialMode:"personal"}', async () => {
    const { user } = renderDrawer();
    await user.click(within(drawer()).getByRole('button', { name: 'Switch to own keys' }));
    await user.click(within(confirmDialog('Let everyone use their own key?')).getByRole('button', { name: 'Cancel' }));
    expect(api.bodies('PATCH', SERVER)).toEqual([]);

    await user.click(within(drawer()).getByRole('button', { name: 'Switch to own keys' }));
    const ask = confirmDialog('Let everyone use their own key?');
    expect(ask).toHaveTextContent('Members without their own key lose access until they add one.');
    await user.click(within(ask).getByRole('button', { name: 'Switch to own keys' }));
    expect(api.bodies('PATCH', SERVER)).toEqual([{ credentialMode: 'personal' }]);
});

it('"Replace key" opens a key field; "Check and save" PUTs the trimmed key and closes it', async () => {
    const { user } = renderDrawer();
    await user.click(screen.getByRole('button', { name: 'Replace key' }));
    const save = screen.getByRole('button', { name: 'Check and save' });
    expect(save).toBeDisabled();

    await user.type(screen.getByLabelText('Sentry token'), '  sntrys_new  ');
    await user.click(save);
    expect(api.bodies('PUT', `${SERVER}/credential`)).toEqual([{ value: 'sntrys_new' }]);
    expect(await screen.findByRole('button', { name: 'Replace key' })).toBeInTheDocument();
    expect(screen.queryByLabelText('Sentry token')).not.toBeInTheDocument();
});

it('a refused key keeps the field open and says why', async () => {
    api.on('PUT', `${SERVER}/credential`, { status: 422, body: { error: 'HTTP 401 from upstream', code: 'connect_auth_failed' } });
    const { user } = renderDrawer();
    await user.click(screen.getByRole('button', { name: 'Replace key' }));
    await user.type(screen.getByLabelText('Sentry token'), 'bad');
    await user.click(screen.getByRole('button', { name: 'Check and save' }));
    expect(await within(drawer()).findByRole('alert')).toHaveTextContent('The server refused the key.');
    expect(screen.getByLabelText('Sentry token')).toHaveValue('bad');
});

it('with personal keys it offers one shared key instead, and no switch', () => {
    renderDrawer({ credentialMode: 'personal' });
    expect(screen.getByText('Everyone uses their own key')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Use one key for everyone' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Switch to own keys' })).not.toBeInTheDocument();
});

it('a server without a key has no Key section', () => {
    renderDrawer({ credentialMode: 'none', credential: null, authStyle: 'none' });
    expect(screen.queryByRole('heading', { name: 'Key' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Replace key' })).not.toBeInTheDocument();
});

it('Remove asks first, then DELETEs and closes the drawer', async () => {
    const { user, onClose } = renderDrawer();
    await user.click(screen.getByRole('button', { name: 'Remove server' }));
    const ask = confirmDialog('Remove Sentry?');
    await user.click(within(ask).getByRole('button', { name: 'Remove' }));
    expect(api.bodies('DELETE', SERVER)).toEqual([undefined]);
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
});

it('a cancelled Remove sends nothing and keeps the drawer open', async () => {
    const { user, onClose } = renderDrawer();
    await user.click(screen.getByRole('button', { name: 'Remove server' }));
    await user.click(within(confirmDialog('Remove Sentry?')).getByRole('button', { name: 'Cancel' }));
    expect(api.bodies('DELETE', SERVER)).toEqual([]);
    expect(onClose).not.toHaveBeenCalled();
});

it('a server the policy blocks says why, and cannot be switched on or checked for tools', () => {
    renderDrawer({ blockedByPolicy: true, blockedReason: 'host_not_allowed', status: 'disabled' });
    expect(drawer()).toHaveTextContent('Blocked by policy');
    expect(screen.getByText('This host is no longer on your server administrator\'s list. The server is kept but does not run.')).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Running' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Check for new tools' })).toBeDisabled();
});

it('"Check for new tools" marks what the server added, which stays off', async () => {
    api.on('POST', `${SERVER}/refresh`, { body: { server: installedServer(), newTools: ['delete_project'] } });
    const { user } = renderDrawer();
    await user.click(screen.getByRole('button', { name: 'Check for new tools' }));
    expect(await screen.findByText('The server has new tools. They stay off until you switch them on.')).toBeInTheDocument();
    expect(within(tool('delete_project').closest('label') as HTMLElement).getByText('New')).toBeInTheDocument();
    expect(tool('delete_project')).not.toBeChecked();
    expect(api.bodies('POST', `${SERVER}/refresh`)).toEqual([{}]);
});

it('an unsaved tool edit survives an unrelated update of the row, and yields to a new stored selection', async () => {
    const { user, rerender } = renderDrawer();
    await user.click(tool('update_issue'));
    rerender({ status: 'disabled' });
    expect(tool('update_issue')).not.toBeChecked();
    expect(screen.getByRole('button', { name: 'Save tools' })).toBeInTheDocument();

    const stored = installedServer().tools.map(tl => ({ ...tl, enabled: tl.name === 'delete_project' }));
    rerender({ status: 'disabled', tools: stored });
    expect(tool('delete_project')).toBeChecked();
    expect(tool('list_issues')).not.toBeChecked();
    expect(screen.queryByRole('button', { name: 'Save tools' })).not.toBeInTheDocument();
});

// A blocked server keeps status 'active' and would run again by itself once
// the server administrator relaxes the policy, so switching it OFF stays
// possible (only switching ON is refused while blocked).
it('a blocked server that is still active can be switched off', async () => {
    const { user } = renderDrawer({ blockedByPolicy: true, blockedReason: 'not_official', status: 'active' });
    await user.click(screen.getByRole('checkbox', { name: 'Running' }));
    expect(api.bodies('PATCH', SERVER)).toEqual([{ enabled: false }]);
});
