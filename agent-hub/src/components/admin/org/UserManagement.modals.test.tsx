import { render, screen, fireEvent, cleanup, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import UserManagement from './UserManagement';
import { authFetch } from '@/utils/helpers';
import { asMock } from '@/test/mocks';

/**
 * P2 coherence pass: the four hand-rolled modals were `fixed inset-0 z-50` divs
 * with no focus trap, no ESC handling and no focus restoration, and every
 * destructive action went through window.confirm() — unstyled, unthemeable,
 * blocking, and untestable.
 *
 * These tests pin the properties that replacement bought. They are the reason
 * the swap is safe to make in a 1200-line file with no prior coverage.
 */

const mode = vi.hoisted(() => ({ selfHosted: false }));
vi.mock('@/hooks/useDeploymentMode', () => ({
    useDeploymentMode: () => ({ mode: mode.selfHosted ? 'self-hosted' : 'cloud', isCloud: !mode.selfHosted, isSelfHosted: mode.selfHosted }),
}));
vi.mock('@/utils/helpers', () => ({ API_BASE: '', authFetch: vi.fn() }));
vi.mock('@/hooks/useTranslation', () => import('@/test/useTranslationParamsMock'));

const jsonRes = (body: unknown, status = 200) => Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => 'application/json' },
    json: async () => body,
});

const JAN = { id: 'u_jan', username: 'jan', displayName: 'Jan de Vries', email: 'jan@acme.nl', orgRole: 'org_admin', organizationId: 'o1', groups: [], status: 'active' };

// The admin dashboard's lists carry ?scope=admin; the role table and the permission catalogue do not.
const FIXTURES: Record<string, unknown> = {
    '/auth/users?scope=admin': [JAN],
    '/auth/groups?scope=admin': [],
    '/auth/roles': [],
    '/auth/permissions': [],
    '/auth/organizations?scope=admin': [{ id: 'o1', name: 'Acme B.V.' }],
};

const fullAdmin = { id: 'me', permissions: ['all'], isAdmin: true, organizations: ['o1'] };

const renderPanel = async () => {
    render(<UserManagement user={fullAdmin} />);
    await screen.findByText('Jan de Vries');
};

describe('UserManagement — modals and confirmations', () => {
    beforeEach(() => {
        cleanup();
        mode.selfHosted = false;
        asMock(authFetch).mockReset();
        asMock(authFetch).mockImplementation((url: string) => {
            const hit = Object.keys(FIXTURES).find((p) => url === p);
            return jsonRes(hit ? FIXTURES[hit] : {});
        });
    });

    it('opens the user modal as a real dialog', async () => {
        const user = userEvent.setup();
        await renderPanel();
        await user.click(screen.getByText('Add user'));
        const dialog = await screen.findByRole('dialog');
        expect(within(dialog).getByText('Add new user')).toBeInTheDocument();
    });

    it('closes the user modal on ESC — impossible with the old inline div', async () => {
        const user = userEvent.setup();
        await renderPanel();
        await user.click(screen.getByText('Add user'));
        expect(await screen.findByRole('dialog')).toBeInTheDocument();

        fireEvent.keyDown(document, { key: 'Escape' });
        await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    });

    it('closes the user modal on Cancel', async () => {
        const user = userEvent.setup();
        await renderPanel();
        await user.click(screen.getByText('Add user'));
        const dialog = await screen.findByRole('dialog');
        await user.click(within(dialog).getByText('Cancel'));
        await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    });

    it('moves focus into the dialog when it opens', async () => {
        const user = userEvent.setup();
        await renderPanel();
        await user.click(screen.getByText('Add user'));
        const dialog = await screen.findByRole('dialog');
        await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
    });

    it('opens the edit modal seeded with the user', async () => {
        const user = userEvent.setup();
        await renderPanel();
        await user.click(screen.getByLabelText('Edit Jan de Vries'));
        const dialog = await screen.findByRole('dialog');
        expect(within(dialog).getByText('Edit user')).toBeInTheDocument();
        expect(within(dialog).getByDisplayValue('Jan de Vries')).toBeInTheDocument();
    });

    it('asks before deleting a user, and does nothing until confirmed', async () => {
        const user = userEvent.setup();
        await renderPanel();
        await user.click(screen.getByLabelText('Delete Jan de Vries'));

        expect(await screen.findByText('Delete this user?')).toBeInTheDocument();
        expect(asMock(authFetch).mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(false);
    });

    it('cancelling the confirm leaves the user alone', async () => {
        const user = userEvent.setup();
        await renderPanel();
        await user.click(screen.getByLabelText('Delete Jan de Vries'));
        const dialog = await screen.findByRole('dialog');

        await user.click(within(dialog).getByText('Cancel'));
        await waitFor(() => expect(screen.queryByText('Delete this user?')).not.toBeInTheDocument());
        expect(asMock(authFetch).mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(false);
    });

    it('confirming the delete issues the DELETE', async () => {
        const user = userEvent.setup();
        await renderPanel();
        await user.click(screen.getByLabelText('Delete Jan de Vries'));
        const dialog = await screen.findByRole('dialog');

        await user.click(within(dialog).getByText('Delete'));
        await waitFor(() =>
            expect(authFetch).toHaveBeenCalledWith('/auth/users/u_jan', expect.objectContaining({ method: 'DELETE' })),
        );
    });

    it('asks before resetting 2FA, naming the person', async () => {
        const user = userEvent.setup();
        await renderPanel();
        await user.click(screen.getByLabelText('Reset 2FA for Jan de Vries'));

        expect(await screen.findByText('Reset two-factor authentication?')).toBeInTheDocument();
        expect(screen.getByText(/Reset two-factor authentication for Jan de Vries\?/)).toBeInTheDocument();
        expect(asMock(authFetch).mock.calls.some(([url]) => String(url).includes('/mfa/reset'))).toBe(false);
    });

    it('confirming the 2FA reset posts to the reset endpoint', async () => {
        const user = userEvent.setup();
        await renderPanel();
        await user.click(screen.getByLabelText('Reset 2FA for Jan de Vries'));
        const dialog = await screen.findByRole('dialog');

        await user.click(within(dialog).getByText('Reset 2FA'));
        await waitFor(() =>
            expect(authFetch).toHaveBeenCalledWith('/auth/users/u_jan/mfa/reset', expect.objectContaining({ method: 'POST' })),
        );
    });

    it('never falls back to window.confirm', async () => {
        const user = userEvent.setup();
        // The whole point of the pass: a blocking native dialog cannot be themed,
        // cannot be translated by t(), and silently no-ops in some embedded views.
        const confirmSpy = vi.spyOn(window, 'confirm');
        await renderPanel();
        await user.click(screen.getByLabelText('Delete Jan de Vries'));
        await screen.findByRole('dialog');
        expect(confirmSpy).not.toHaveBeenCalled();
        confirmSpy.mockRestore();
    });
});

describe('UserManagement: user monthly AI budget (self-hosted)', () => {
    const putCall = () => asMock(authFetch).mock.calls.find(([, init]) => init?.method === 'PUT');
    const saved = async (user: ReturnType<typeof userEvent.setup>, dialog: HTMLElement) => {
        await user.click(within(dialog).getByText('Save'));
        await waitFor(() => expect(putCall()).toBeDefined());
        return JSON.parse(putCall()![1].body);
    };

    beforeEach(() => {
        cleanup();
        mode.selfHosted = true;
        asMock(authFetch).mockReset();
        asMock(authFetch).mockImplementation((url: string, init?: { method?: string }) => {
            if (init?.method === 'PUT') return jsonRes({ success: true });
            if (url === '/auth/users?scope=admin') return jsonRes([{ ...JAN, monthlyCostLimit: 12.5 }]);
            return jsonRes(FIXTURES[url] ?? {});
        });
    });

    const openEdit = async () => {
        const user = userEvent.setup();
        await renderPanel();
        await user.click(screen.getByLabelText('Edit Jan de Vries'));
        return { user, dialog: await screen.findByRole('dialog') };
    };

    it('shows the field with the stored amount', async () => {
        const { dialog } = await openEdit();
        expect(within(dialog).getByLabelText('Monthly AI budget (€)')).toHaveValue(12.5);
    });

    it('hides the field outside self-hosted mode and does not send it', async () => {
        mode.selfHosted = false;
        const { user, dialog } = await openEdit();
        expect(within(dialog).queryByLabelText('Monthly AI budget (€)')).not.toBeInTheDocument();
        expect(await saved(user, dialog)).not.toHaveProperty('monthlyCostLimit');
    });

    it('sends the amount as a number', async () => {
        const { user, dialog } = await openEdit();
        const field = within(dialog).getByLabelText('Monthly AI budget (€)');
        await user.clear(field);
        await user.type(field, '30');
        expect((await saved(user, dialog)).monthlyCostLimit).toBe(30);
    });

    it('sends null when the field is emptied', async () => {
        const { user, dialog } = await openEdit();
        await user.clear(within(dialog).getByLabelText('Monthly AI budget (€)'));
        expect((await saved(user, dialog)).monthlyCostLimit).toBeNull();
    });

    it('refuses zero without calling the server', async () => {
        const { user, dialog } = await openEdit();
        const field = within(dialog).getByLabelText('Monthly AI budget (€)');
        await user.clear(field);
        await user.type(field, '0');
        await user.click(within(dialog).getByText('Save'));
        expect(putCall()).toBeUndefined();
    });
});

/**
 * The platform administrator switch of Admin > Security > Users: only a
 * platform admin sees it, granting asks first and names the person, the PUT
 * carries the platform role, the server's refusal for the last platform admin
 * is shown in the form, and the people list marks platform admins apart from
 * their organisation role. A platform admin's row offers edit, 2FA reset and
 * delete to a platform admin only (the server refuses anyone else).
 */
describe('UserManagement: platform administrator', () => {
    const MEMBER = { id: 'u_jan', username: 'jan', displayName: 'Jan de Vries', role: 'user', orgRole: 'member', organizationId: 'o1', groups: [], status: 'active' };
    const PLATFORM = { id: 'u_ann', username: 'ann', displayName: 'Ann Smit', role: 'admin', orgRole: 'org_admin', organizationId: 'o1', groups: [], status: 'active' };
    const platformAdmin = { id: 'u_ann', role: 'admin', isAdmin: true, permissions: [], organizations: ['o1'] };
    const orgAdmin = { id: 'u_piet', role: 'user', orgRole: 'org_admin', permissions: ['manage_users'], organizations: ['o1'], organizationId: 'o1' };

    let putResponse: () => Promise<unknown> = () => jsonRes({ success: true });
    const putBody = () => {
        const call = asMock(authFetch).mock.calls.find(([, init]) => init?.method === 'PUT');
        return call ? JSON.parse(call[1].body) : null;
    };
    const rowOf = (name: string) => screen.getByText(name).closest('[data-testid="people-row"]') as HTMLElement;

    async function openEdit(currentUser: Record<string, unknown>, name: string) {
        const user = userEvent.setup();
        render(<UserManagement user={currentUser} />);
        await user.click(await screen.findByLabelText(`Edit ${name}`));
        return { user, dialog: await screen.findByRole('dialog') };
    }

    beforeEach(() => {
        cleanup();
        mode.selfHosted = false;
        putResponse = () => jsonRes({ success: true });
        asMock(authFetch).mockReset();
        asMock(authFetch).mockImplementation((url: string, init?: { method?: string }) => {
            if (init?.method === 'PUT') return putResponse();
            if (url === '/auth/users?scope=admin') return jsonRes([MEMBER, PLATFORM]);
            return jsonRes(FIXTURES[url] ?? {});
        });
    });

    it('marks a platform admin in the list next to their organisation role', async () => {
        render(<UserManagement user={platformAdmin} />);
        await screen.findByText('Ann Smit');
        expect(within(rowOf('Ann Smit')).getByText('Platform admin')).toBeInTheDocument();
        expect(within(rowOf('Ann Smit')).getByText('Organisation Admin')).toBeInTheDocument();
        expect(within(rowOf('Jan de Vries')).queryByText('Platform admin')).not.toBeInTheDocument();
    });

    it('offers an organisation admin no edit, 2FA reset or delete on a platform admin, and keeps them on a member', async () => {
        render(<UserManagement user={orgAdmin} />);
        await screen.findByText('Ann Smit');
        expect(within(rowOf('Ann Smit')).queryAllByRole('button')).toHaveLength(0);
        expect(screen.getByLabelText('Edit Jan de Vries')).toBeInTheDocument();
        expect(screen.getByLabelText('Reset 2FA for Jan de Vries')).toBeInTheDocument();
        expect(screen.getByLabelText('Delete Jan de Vries')).toBeInTheDocument();
    });

    it('offers a platform admin the actions on a platform admin', async () => {
        render(<UserManagement user={platformAdmin} />);
        expect(await screen.findByLabelText('Edit Ann Smit')).toBeInTheDocument();
        expect(screen.getByLabelText('Reset 2FA for Ann Smit')).toBeInTheDocument();
        expect(screen.getByLabelText('Delete Ann Smit')).toBeInTheDocument();
    });

    it('is not offered to an organisation admin', async () => {
        const { dialog } = await openEdit(orgAdmin, 'Jan de Vries');
        expect(within(dialog).queryByRole('checkbox', { name: 'Platform administrator' })).not.toBeInTheDocument();
    });

    it('asks before granting, names the person, and sends the platform role', async () => {
        const { user, dialog } = await openEdit(platformAdmin, 'Jan de Vries');
        const toggle = within(dialog).getByRole('checkbox', { name: 'Platform administrator' });
        expect(within(dialog).getByText('Can change settings for the whole server and see every organisation.')).toBeInTheDocument();
        await user.click(toggle);

        expect(await screen.findByText('Make Jan de Vries a platform administrator?')).toBeInTheDocument();
        expect(screen.getByText('Jan de Vries can change settings for the whole server and see every organisation.')).toBeInTheDocument();
        await user.click(screen.getByRole('button', { name: 'Make platform administrator' }));
        await waitFor(() => expect(toggle).toBeChecked());

        await user.click(within(dialog).getByText('Save'));
        await waitFor(() => expect(putBody()).not.toBeNull());
        expect(putBody().role).toBe('admin');
    });

    it('leaves the role alone when the confirmation is cancelled', async () => {
        const { user, dialog } = await openEdit(platformAdmin, 'Jan de Vries');
        const toggle = within(dialog).getByRole('checkbox', { name: 'Platform administrator' });
        await user.click(toggle);
        const confirmDialog = (await screen.findAllByRole('dialog')).at(-1) as HTMLElement;
        expect(confirmDialog).toHaveTextContent('Make Jan de Vries a platform administrator?');
        await user.click(within(confirmDialog).getByRole('button', { name: 'Cancel' }));
        await waitFor(() => expect(screen.getAllByRole('dialog')).toHaveLength(1));
        expect(toggle).not.toBeChecked();
    });

    it('asks before you give up your own role, and shows the server refusal for the last platform admin', async () => {
        putResponse = () => jsonRes({ code: 'last_platform_admin', error: 'refused' }, 409);
        const { user, dialog } = await openEdit(platformAdmin, 'Ann Smit');
        const toggle = within(dialog).getByRole('checkbox', { name: 'Platform administrator' });
        expect(toggle).toBeChecked();
        await user.click(toggle);

        expect(await screen.findByText('Give up your platform administrator rights?')).toBeInTheDocument();
        await user.click(screen.getByRole('button', { name: 'Give them up' }));
        await waitFor(() => expect(toggle).not.toBeChecked());

        await user.click(within(dialog).getByText('Save'));
        await waitFor(() => expect(putBody()?.role).toBe('user'));
        expect(await within(dialog).findByRole('alert')).toHaveTextContent('This is the last active platform administrator');
        expect(toggle).toBeChecked();
    });
});
