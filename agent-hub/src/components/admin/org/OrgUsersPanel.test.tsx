import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { MockInstance } from 'vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { withQueryClient } from '@/test/render';
import { asMock } from '@/test/mocks';
import { tab } from '@/test/orgUsersPanelMocks';
import { ADMIN, NOBODY, USERS, buttonOf, jsonRes, notJsonRes, renderPanel, resetPanel, row, writes } from '@/test/orgUsersPanelKit';
import { authFetch } from '@/utils/helpers';
import OrgUsersPanel from './OrgUsersPanel';
/**
 * Characterisation suite for OrgUsersPanel — the org rights screen: its member
 * list, roles, pending members, invitations and sections. The Groups and Roles
 * tabs are OrgUsersPanel.groups.test.tsx; the member filter bar is
 * OrgUsersPanel.filters.test.tsx; the shared set-up is @/test/orgUsersPanelKit.
 *
 * It pins today's behaviour: who sees which control, what a missing or unknown
 * role renders as, what a failed fetch/write leaves on screen, and which
 * destructive actions ask first.
 *
 * These tests describe reality, warts included. Where a test name says "(wrat)"
 * or "(fail-open)" the assertion deliberately locks in behaviour that is wrong
 * or surprising — so the redesign has to change the test on purpose rather than
 * change the behaviour by accident.
 */

vi.mock('@/utils/helpers', () => ({ API_BASE: '', authFetch: vi.fn() }));
vi.mock('@/components/shared/Toast', () => import('@/test/orgUsersPanelMocks'));
vi.mock('@/hooks/useTranslation', () => import('@/test/useTranslationParamsMock'));
vi.mock('@/hooks/useUrlTab', () => import('@/test/orgUsersPanelMocks'));
vi.mock('./OrgCustomTiersPanel', () => ({ default: () => <div data-testid="custom-tiers-panel" /> }));
vi.mock('../../integrations/nextcloud/NextcloudSyncPanel', () => ({
    default: ({ user }: { user?: { id?: string } }) => <div data-testid="nc-sync-panel">{user?.id}</div>,
}));

let errorSpy: MockInstance;
let confirmSpy: MockInstance;

beforeEach(() => { ({ errorSpy, confirmSpy } = resetPanel()); });
afterEach(() => { vi.restoreAllMocks(); });

// ══════════════════════════════════════════════════════════ loading / errors ══

describe('OrgUsersPanel — loading and failed fetches', () => {
    it('shows the user-list skeleton while the first fetch is in flight', () => {
        asMock(authFetch).mockImplementation(() => new Promise(() => {}));
        render(withQueryClient(<OrgUsersPanel user={ADMIN} />));
        expect(screen.getByTestId('user-list-skeleton')).toBeInTheDocument();
        expect(screen.queryByText('Organisation Members')).not.toBeInTheDocument();
    });

    it('a network failure leaves an empty member list and shows no error at all (wrat)', async () => {
        await renderPanel({ networkDown: true });
        expect(screen.getByText('No users yet')).toBeInTheDocument();
        // The only trace of the failure is a console line.
        expect(errorSpy).toHaveBeenCalledWith('Failed to fetch org data:', expect.any(Error));
        expect(screen.queryByText(/could not|failed|error/i)).not.toBeInTheDocument();
    });

    it('a 403 on the admin-scoped member list says the page is for organisation admins, not "no users yet"', async () => {
        await renderPanel({ getOverrides: { '/auth/users?scope=admin': { status: 403, body: { error: 'forbidden' } } } });
        expect(screen.getByRole('status')).toHaveTextContent(/for administrators of the organisation/);
        expect(screen.queryByText('No users yet')).not.toBeInTheDocument();
    });

    it('keeps the Invite User button on a failed fetch, so an empty org still offers to invite', async () => {
        await renderPanel({ networkDown: true });
        expect(screen.getByText('Invite User')).toBeInTheDocument();
    });

    it('"Manage Groups" in the empty state navigates to the groups section', async () => {
        await renderPanel({ users: [] });
        await userEvent.click(screen.getByText('Manage Groups'));
        expect(tab.navigated).toContain('groups');
    });
});

// ══════════════════════════════════════════════════════ member list & roles ══

describe('OrgUsersPanel — member list rendering', () => {
    it('lists members with name, email and the org-role chip', async () => {
        await renderPanel();
        const jan = row('Jan de Vries');
        expect(within(jan).getByText('jan@acme.nl')).toBeInTheDocument();
        expect(within(jan).getByText('Organisation admin')).toBeInTheDocument();
        expect(within(row('Eva Bakker')).getByText('Member')).toBeInTheDocument();
    });

    it('drops isSystem rows but keeps every other user the server returned', async () => {
        await renderPanel({
            users: [...USERS, { id: 'u_sys', displayName: 'System Bot', isSystem: true, groups: [] }],
        });
        expect(screen.queryByText('System Bot')).not.toBeInTheDocument();
        expect(screen.getByText('Jan de Vries')).toBeInTheDocument();
    });

    it('renders a member of a DIFFERENT organisation when the server returns one — no client-side org scoping (wrat)', async () => {
        await renderPanel({
            users: [...USERS, { id: 'u_out', displayName: 'Outsider Inc', email: 'out@other.nl', organizationId: 'orgB', orgRole: 'member', groups: [] }],
        });
        expect(screen.getByText('Outsider Inc')).toBeInTheDocument();
    });

    it('falls back to the first letter of the display name as avatar', async () => {
        await renderPanel();
        expect(within(row('Jan de Vries')).getByText('J')).toBeInTheDocument();
    });

    it('shows the group-name chips for the groups the member belongs to', async () => {
        await renderPanel();
        const eva = row('Eva Bakker');
        expect(within(eva).getByText('Finance')).toBeInTheDocument();
        expect(within(eva).getByText('Support')).toBeInTheDocument();
    });

    it('counts members in the Users tab badge from the unfiltered list', async () => {
        await renderPanel();
        const usersTab = buttonOf('Users');
        expect(within(usersTab).getByText('2')).toBeInTheDocument();
        // Filtering the list down to a single row leaves the badge at 2.
        fireEvent.change(screen.getByLabelText('Search by name or email…'), { target: { value: 'Eva' } });
        expect(screen.queryByText('Jan de Vries')).not.toBeInTheDocument();
        expect(within(usersTab).getByText('2')).toBeInTheDocument();
    });
});

describe('OrgUsersPanel — how a role is displayed (rights-sensitive)', () => {
    const only = (u: Record<string, unknown>) => ({ users: [u] });

    it('a user with NO role at all reads as a member, as every other plain account does', async () => {
        await renderPanel(only({ id: 'u_none', displayName: 'Noor Zonder', groups: [], status: 'active' }));
        expect(within(row('Noor Zonder')).getByText('Member')).toBeInTheDocument();
    });

    it('an UNKNOWN role is printed verbatim in the same neutral chip as every role (fail-open)', async () => {
        await renderPanel(only({ id: 'u_x', displayName: 'Xander Onbekend', orgRole: 'superuser', groups: [], status: 'active' }));
        const chip = within(row('Xander Onbekend')).getByText('superuser');
        expect(chip).toBeInTheDocument();
        expect(chip).toHaveAttribute('data-testid', 'people-role');
    });

    it('legacy orgRole "admin" renders verbatim, not as Organisation admin (fail-open)', async () => {
        await renderPanel(only({ id: 'u_legacy', displayName: 'Lea Legacy', orgRole: 'admin', role: 'admin', groups: [], status: 'active' }));
        expect(within(row('Lea Legacy')).getByText('admin')).toBeInTheDocument();
        expect(within(row('Lea Legacy')).queryByText('Organisation admin')).not.toBeInTheDocument();
    });

    it('never shows a role inherited from a group — the chip is the personal role only (fail-open)', async () => {
        // Eva is in Support, and Support carries orgRole 'agent_admin' ("All
        // members inherit this role" in the group view). Her chip says Member.
        await renderPanel();
        const eva = row('Eva Bakker');
        expect(within(eva).getByText('Member')).toBeInTheDocument();
        expect(within(eva).queryByText('Agent admin')).not.toBeInTheDocument();
    });

    it('prefers orgRole over the system role when a user has both (orgRole || role)', async () => {
        await renderPanel(only({ id: 'u_both', displayName: 'Bea Beide', role: 'admin', orgRole: 'member', groups: [], status: 'active' }));
        const r = row('Bea Beide');
        expect(within(r).getByText('Member')).toBeInTheDocument();
        expect(within(r).queryByText('admin')).not.toBeInTheDocument();
    });

    it('falls back to users.role when orgRole is missing (orgRole || role)', async () => {
        await renderPanel(only({ id: 'u_r', displayName: 'Rob Rol', role: 'agent_editor', groups: [], status: 'active' }));
        expect(within(row('Rob Rol')).getByText('Agent editor')).toBeInTheDocument();
    });
});

// ═════════════════════════════════════════════════════════ role editing ══════

describe('OrgUsersPanel — changing a role', () => {
    const openRoleEditor = (name: string) => {
        fireEvent.click(within(row(name)).getByTitle('Change role'));
        return within(row(name)).getByRole<HTMLSelectElement>('combobox');
    };

    it('offers both "User" and "Member" as separate options for the same thing (wrat)', async () => {
        await renderPanel();
        const select = openRoleEditor('Jan de Vries');
        const labels = within(select).getAllByRole('option').map(o => o.textContent);
        expect(labels).toEqual(['User', 'Organisation admin', 'Data protection officer', 'ISMS internal auditor', 'Agent admin', 'Agent editor', 'Member']);
    });

    it('preselects the current role', async () => {
        await renderPanel();
        expect(openRoleEditor('Jan de Vries').value).toBe('org_admin');
    });

    it('preselects "User" for a member who has no orgRole at all', async () => {
        await renderPanel({ users: [{ id: 'u_none', displayName: 'Noor Zonder', groups: [], status: 'active' }] });
        expect(openRoleEditor('Noor Zonder').value).toBe('user');
    });

    it('shows "User" for a legacy admin because no option matches the stored role (fail-open)', async () => {
        await renderPanel({ users: [{ id: 'u_legacy', displayName: 'Lea Legacy', orgRole: 'admin', groups: [], status: 'active' }] });
        expect(openRoleEditor('Lea Legacy').value).toBe('user');
    });

    it('PUTs the new orgRole and closes the editor on success', async () => {
        await renderPanel();
        fireEvent.change(openRoleEditor('Eva Bakker'), { target: { value: 'agent_admin' } });
        await waitFor(() => expect(writes()).toContainEqual({
            url: '/auth/users/u_member', method: 'PUT', body: { orgRole: 'agent_admin' },
        }));
        await waitFor(() => expect(within(row('Eva Bakker')).queryByRole('combobox')).not.toBeInTheDocument());
    });

    it('surfaces a refused role change with the server error text, dismissible', async () => {
        await renderPanel({
            write: () => jsonRes({ error: 'This is the last organisation administrator.', code: 'last_org_admin' }, 409),
        });
        fireEvent.change(openRoleEditor('Jan de Vries'), { target: { value: 'member' } });
        const banner = await screen.findByText('This is the last organisation administrator.');
        expect(banner).toBeInTheDocument();
        await userEvent.click(within(banner.parentElement as HTMLElement).getByRole('button'));
        await waitFor(() => expect(screen.queryByText('This is the last organisation administrator.')).not.toBeInTheDocument());
    });

    it('leaves the role dropdown open on a refusal, still showing the role that was not saved (wrat)', async () => {
        await renderPanel({ write: () => jsonRes({ error: 'nope' }, 409) });
        fireEvent.change(openRoleEditor('Jan de Vries'), { target: { value: 'member' } });
        await screen.findByText('nope');
        expect(within(row('Jan de Vries')).getByRole('combobox')).toBeInTheDocument();
    });

    it('falls back to a generic message when the refusal body is not JSON', async () => {
        await renderPanel({ write: () => notJsonRes(500) });
        fireEvent.change(openRoleEditor('Jan de Vries'), { target: { value: 'member' } });
        expect(await screen.findByText('That role change could not be applied.')).toBeInTheDocument();
    });

    it('reports a network failure during a role change with the same generic message', async () => {
        await renderPanel({ write: () => Promise.reject(new Error('offline')) });
        fireEvent.change(openRoleEditor('Jan de Vries'), { target: { value: 'member' } });
        expect(await screen.findByText('That role change could not be applied.')).toBeInTheDocument();
    });

    it('asks for confirmation before a self-demotion and re-sends with confirmSelfDemotion', async () => {
        let calls = 0;
        await renderPanel({
            write: () => {
                calls += 1;
                return calls === 1
                    ? jsonRes({ code: 'confirm_self_demotion', error: 'Are you sure?', hint: { message: 'You are about to remove your own admin rights.' } }, 409)
                    : jsonRes({ success: true });
            },
        });
        fireEvent.change(openRoleEditor('Jan de Vries'), { target: { value: 'member' } });

        expect(await screen.findByText('Give up your admin rights?')).toBeInTheDocument();
        expect(screen.getByText('You are about to remove your own admin rights.')).toBeInTheDocument();
        await userEvent.click(screen.getByText('Yes, step down'));

        await waitFor(() => expect(writes()).toContainEqual({
            url: '/auth/users/u_admin', method: 'PUT', body: { orgRole: 'member', confirmSelfDemotion: true },
        }));
    });

    it('cancelling the self-demotion dialog sends nothing more', async () => {
        await renderPanel({
            write: () => jsonRes({ code: 'confirm_self_demotion', error: 'Are you sure?' }, 409),
        });
        fireEvent.change(openRoleEditor('Jan de Vries'), { target: { value: 'member' } });
        await screen.findByText('Give up your admin rights?');
        await userEvent.click(screen.getByText('Cancel'));
        await waitFor(() => expect(screen.queryByText('Give up your admin rights?')).not.toBeInTheDocument());
        expect(writes()).toHaveLength(1);
    });

    it('the X next to the role dropdown closes it without sending anything', async () => {
        await renderPanel();
        const select = openRoleEditor('Jan de Vries');
        const closeBtn = within(select.parentElement as HTMLElement).getByRole('button');
        await userEvent.click(closeBtn);
        expect(within(row('Jan de Vries')).queryByRole('combobox')).not.toBeInTheDocument();
        expect(writes()).toHaveLength(0);
    });
});

// ══════════════════════════════════════════════════════════ pending members ══

describe('OrgUsersPanel — pending members', () => {
    const PENDING = { id: 'u_pending', displayName: 'Piet Jansen', email: 'piet@acme.nl', orgRole: 'org_admin', groups: [], status: 'pending' };

    it('shows a Pending badge instead of the role chip, even for a pending org_admin (wrat)', async () => {
        await renderPanel({ users: [PENDING] });
        const r = row('Piet Jansen');
        expect(within(r).getByText('Pending')).toBeInTheDocument();
        expect(within(r).queryByText('Organisation admin')).not.toBeInTheDocument();
    });

    it('replaces role editing and group assignment with Approve / Reject', async () => {
        await renderPanel({ users: [PENDING] });
        const r = row('Piet Jansen');
        expect(within(r).getByText('Approve')).toBeInTheDocument();
        expect(within(r).getByText('Reject')).toBeInTheDocument();
        expect(within(r).queryByTitle('Change role')).not.toBeInTheDocument();
        expect(within(r).queryByTitle('Assign groups')).not.toBeInTheDocument();
    });

    it('Approve grants access immediately, with no confirmation, and forces orgRole "user"', async () => {
        await renderPanel({ users: [PENDING] });
        await userEvent.click(within(row('Piet Jansen')).getByText('Approve'));
        await waitFor(() => expect(writes()).toContainEqual({
            url: '/auth/users/u_pending', method: 'PUT', body: { status: 'active', orgRole: 'user' },
        }));
        expect(confirmSpy).not.toHaveBeenCalled();
    });

    it('Reject asks in the app\'s own dialog first and sends nothing while it is declined', async () => {
        await renderPanel({ users: [PENDING] });
        await userEvent.click(within(row('Piet Jansen')).getByText('Reject'));
        const dialog = await screen.findByRole('dialog', { name: 'Reject and remove this user?' });
        expect(within(dialog).getByText('They can sign up again later.')).toBeInTheDocument();
        expect(confirmSpy).not.toHaveBeenCalled();
        await userEvent.click(screen.getByTestId('confirm-dialog-cancel'));
        await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
        expect(writes()).toHaveLength(0);
    });

    it('Reject DELETEs the account once confirmed', async () => {
        await renderPanel({ users: [PENDING] });
        await userEvent.click(within(row('Piet Jansen')).getByText('Reject'));
        await userEvent.click(await screen.findByTestId('confirm-dialog-confirm'));
        await waitFor(() => expect(writes()).toContainEqual({
            url: '/auth/users/u_pending', method: 'DELETE', body: undefined,
        }));
    });
});

// ═════════════════════════════════════════════════════════════ permissions ══

describe('OrgUsersPanel — who may see the controls', () => {
    it('shows every write control to a viewer with no role, no permissions and no organisation (fail-open)', async () => {
        await renderPanel({
            users: [...USERS, { id: 'u_p', displayName: 'Piet Jansen', groups: [], status: 'pending' }],
        }, NOBODY);
        expect(screen.getByText('Invite User')).toBeInTheDocument();
        expect(within(row('Jan de Vries')).getByTitle('Change role')).toBeInTheDocument();
        expect(within(row('Jan de Vries')).getByTitle('Assign groups')).toBeInTheDocument();
        expect(within(row('Piet Jansen')).getByText('Approve')).toBeInTheDocument();
        expect(within(row('Piet Jansen')).getByText('Reject')).toBeInTheDocument();
    });

    it('lets that same roleless viewer actually fire the role change (no client-side gate)', async () => {
        await renderPanel({}, NOBODY);
        await userEvent.click(within(row('Eva Bakker')).getByTitle('Change role'));
        fireEvent.change(within(row('Eva Bakker')).getByRole('combobox'), { target: { value: 'org_admin' } });
        await waitFor(() => expect(writes()).toContainEqual({
            url: '/auth/users/u_member', method: 'PUT', body: { orgRole: 'org_admin' },
        }));
    });
});

// ═══════════════════════════════════════════════════════════ auto-approve ═══

describe('OrgUsersPanel — SSO auto-approve', () => {
    // Its one home is Preferred sign-in method (orgInfo/AutoApproveSetting): no second writer here.
    it('offers no auto-approve switch, also for an SSO organisation', async () => {
        await renderPanel({ organizations: [{ id: 'orgA', name: 'Acme B.V.', authMethod: 'google' }] });
        expect(screen.queryByText('org.auto_approve_sso')).not.toBeInTheDocument();
        expect(writes()).toEqual([]);
    });
});

// ══════════════════════════════════════════════════════════════ invitations ══

describe('OrgUsersPanel — invitations', () => {
    const openInvite = () => fireEvent.click(screen.getByText('Invite User'));

    it('toggles the invite form and disables Send until an address is typed', async () => {
        await renderPanel();
        expect(screen.queryByPlaceholderText('colleague@example.com')).not.toBeInTheDocument();
        openInvite();
        const email = screen.getByPlaceholderText('colleague@example.com');
        expect(buttonOf('Send')).toBeDisabled();
        fireEvent.change(email, { target: { value: 'new@acme.nl' } });
        expect(buttonOf('Send')).not.toBeDisabled();
    });

    it('POSTs the address and role, then reports delivery', async () => {
        await renderPanel({ write: () => jsonRes({ success: true, emailSent: true }) });
        openInvite();
        fireEvent.change(screen.getByPlaceholderText('colleague@example.com'), { target: { value: 'new@acme.nl' } });
        fireEvent.change(screen.getByDisplayValue('User'), { target: { value: 'agent_admin' } });
        await userEvent.click(screen.getByText('Send'));
        await waitFor(() => expect(writes()).toContainEqual({
            url: '/auth/invitations', method: 'POST', body: { email: 'new@acme.nl', role: 'agent_admin' },
        }));
        expect(await screen.findByText('Invitation sent to new@acme.nl')).toBeInTheDocument();
    });

    it('offers a copy-link fallback when the mail could not be delivered', async () => {
        const writeText = vi.fn();
        Object.defineProperty(window.navigator, 'clipboard', { value: { writeText }, configurable: true });
        await renderPanel({ write: () => jsonRes({ success: true, emailSent: false, inviteUrl: 'https://beeflow.nl/invite/abc' }) });
        openInvite();
        fireEvent.change(screen.getByPlaceholderText('colleague@example.com'), { target: { value: 'new@acme.nl' } });
        await userEvent.click(screen.getByText('Send'));
        const copy = await screen.findByText('Copy invite link');
        await userEvent.click(copy);
        expect(writeText).toHaveBeenCalledWith('https://beeflow.nl/invite/abc');
    });

    it('turns a seat-cap refusal into an upgrade link', async () => {
        await renderPanel({ write: () => jsonRes({ error: 'Seat cap reached', code: 'seat_cap_exceeded' }, 402) });
        openInvite();
        fireEvent.change(screen.getByPlaceholderText('colleague@example.com'), { target: { value: 'new@acme.nl' } });
        await userEvent.click(screen.getByText('Send'));
        expect(await screen.findByText('Seat cap reached')).toBeInTheDocument();
        expect(screen.getByText('View plans & upgrade').getAttribute('href')).toBe('/app/admin/organisation/license');
    });

    it('reports a non-JSON server reply as a network error (wrat)', async () => {
        await renderPanel({ write: () => notJsonRes(502) });
        openInvite();
        fireEvent.change(screen.getByPlaceholderText('colleague@example.com'), { target: { value: 'new@acme.nl' } });
        await userEvent.click(screen.getByText('Send'));
        expect(await screen.findByText('Network error — please try again')).toBeInTheDocument();
    });

    it('treats a 200 without success:true as a failure', async () => {
        await renderPanel({ write: () => jsonRes({ success: false, error: 'Domain not allowed' }) });
        openInvite();
        fireEvent.change(screen.getByPlaceholderText('colleague@example.com'), { target: { value: 'new@acme.nl' } });
        await userEvent.click(screen.getByText('Send'));
        expect(await screen.findByText('Domain not allowed')).toBeInTheDocument();
    });

    it('lists pending invitations with inviter, expiry and a role chip for non-default roles', async () => {
        await renderPanel({
            invitations: [
                { id: 'i1', email: 'a@acme.nl', status: 'pending', role: 'org_admin', inviterName: 'Jan', expires_at: '2026-10-01T00:00:00Z' },
                { id: 'i2', email: 'b@acme.nl', status: 'pending', role: 'user', expires_at: '2026-10-01T00:00:00Z' },
            ],
        });
        expect(screen.getByText('Pending Invitations')).toBeInTheDocument();
        const first = row('a@acme.nl');
        expect(within(first).getByText('Organisation admin')).toBeInTheDocument();
        expect(within(first).getByText(/Invited by Jan · Expires/)).toBeInTheDocument();
        // role 'user' gets no chip at all
        const second = row('b@acme.nl');
        expect(within(second).getByText(/Invited by Unknown · Expires/)).toBeInTheDocument();
    });

    it('prints "Invalid Date" when an invitation has no expiry (wrat)', async () => {
        await renderPanel({ invitations: [{ id: 'i1', email: 'a@acme.nl', status: 'pending' }] });
        expect(screen.getByText('Invited by Unknown · Expires Invalid Date')).toBeInTheDocument();
    });

    it('hides the section entirely when every invitation is already accepted', async () => {
        await renderPanel({ invitations: [{ id: 'i1', email: 'a@acme.nl', status: 'accepted' }] });
        expect(screen.queryByText('Pending Invitations')).not.toBeInTheDocument();
    });

    it('revokes an invitation without asking for confirmation', async () => {
        await renderPanel({ invitations: [{ id: 'i1', email: 'a@acme.nl', status: 'pending', expires_at: '2026-10-01T00:00:00Z' }] });
        await userEvent.click(screen.getByTitle('Revoke invitation'));
        await waitFor(() => expect(writes()).toContainEqual({
            url: '/auth/invitations/i1', method: 'DELETE', body: undefined,
        }));
        expect(confirmSpy).not.toHaveBeenCalled();
    });
});

// ══════════════════════════════════════════════════════════════════ usage ════

describe('OrgUsersPanel — per-user AI cost', () => {
    it('formats the 30-day cost in three bands and hides a zero', async () => {
        await renderPanel({
            users: [
                { id: 'u_a', displayName: 'Anna', groups: [], status: 'active' },
                { id: 'u_b', displayName: 'Bram', groups: [], status: 'active' },
                { id: 'u_c', displayName: 'Cees', groups: [], status: 'active' },
                { id: 'u_d', displayName: 'Dana', groups: [], status: 'active' },
            ],
            usage: [
                { user_id: 'u_a', calls: 4000, estimated_cost: 142.4 },
                { user_id: 'u_b', calls: 40, estimated_cost: 3.456 },
                { user_id: 'u_c', calls: 4, estimated_cost: 0.0123 },
                { user_id: 'u_d', calls: 1, estimated_cost: 0 },
            ],
        });
        expect(within(row('Anna')).getByText('€142')).toBeInTheDocument();
        expect(within(row('Bram')).getByText('€3.46')).toBeInTheDocument();
        expect(within(row('Cees')).getByText('€0.012')).toBeInTheDocument();
        expect(within(row('Dana')).queryByText(/^€/)).not.toBeInTheDocument();
    });

    it('stays silent when the usage endpoint fails', async () => {
        await renderPanel({ getOverrides: { '/api/usage/by-user?days=30': { status: 500 } } });
        expect(screen.getByText('Jan de Vries')).toBeInTheDocument();
        expect(screen.queryByText('admin.org_usage_cost_30d')).not.toBeInTheDocument();
    });
});

// ═════════════════════════════════════════════════════════ sections / tabs ═══

describe('OrgUsersPanel — sections', () => {
    it('renders three tabs for a normal org, as a tab list with the current one selected', async () => {
        await renderPanel();
        const tabs = within(screen.getByRole('tablist', { name: 'Users & Groups' })).getAllByRole('tab');
        expect(tabs.map(el => el.textContent)).toEqual(['Users2', 'Groups2', 'Roles6']);
        expect(screen.getByRole('tab', { name: /^Users/ })).toHaveAttribute('aria-selected', 'true');
        expect(screen.getByRole('tab', { name: /^Groups/ })).toHaveAttribute('aria-selected', 'false');
        expect(screen.queryByText('Nextcloud Sync')).not.toBeInTheDocument();
    });

    it('has no Nextcloud Sync tab, not even for an ncOrg: Organisation → Nextcloud Sync shows that panel', async () => {
        await renderPanel({}, { ...ADMIN, ncOrg: { instanceId: 'nc1' } });
        expect(screen.getAllByRole('tab')).toHaveLength(3);
        expect(screen.queryByRole('tab', { name: /Nextcloud/ })).not.toBeInTheDocument();
    });

    it('keeps its addresses under the legacy page by default', async () => {
        await renderPanel();
        expect(tab.basePath).toBe('/app/org-settings/users');
    });

    it('takes the address of the screen that mounts it, so a tab click stays in Settings', async () => {
        render(withQueryClient(<OrgUsersPanel user={ADMIN} basePath="/app/settings/organisation/users" />));
        await waitFor(() => expect(screen.queryByTestId('user-list-skeleton')).not.toBeInTheDocument());
        expect(tab.basePath).toBe('/app/settings/organisation/users');
    });

    it('has no Nextcloud sync of its own: the Nextcloud Sync tab of the page is its one home', async () => {
        tab.section = 'sync';
        await renderPanel({}, { ...ADMIN, ncOrg: { instanceId: 'nc1' } });
        expect(screen.queryByTestId('nc-sync-panel')).not.toBeInTheDocument();
    });

    it('renders the custom-tiers panel for a section that has no tab to reach it (wrat)', async () => {
        tab.section = 'customTiers';
        await renderPanel();
        expect(screen.getByTestId('custom-tiers-panel')).toBeInTheDocument();
        expect(screen.queryByText('Custom Tiers')).not.toBeInTheDocument();
    });

    it('switching tab records the new section', async () => {
        await renderPanel();
        await userEvent.click(screen.getByRole('tab', { name: /^Roles/ }));
        expect(tab.navigated).toContain('roles');
    });
});

// ═══════════════════════════════════════════════════════════ health banner ══

describe('OrgUsersPanel — org health banner', () => {
    it('stays silent when the health endpoint 404s', async () => {
        await renderPanel();
        // Let the failed health round trip land — a banner would be on screen by now.
        await act(async () => { await new Promise(r => { setTimeout(r, 0); }); });
        expect(screen.getByText('Organisation Members')).toBeInTheDocument();
        expect(screen.queryByText(/waiting for approval/)).not.toBeInTheDocument();
    });

    it('surfaces pending approvals above the member list', async () => {
        await renderPanel({ health: { health: 'blocked', users: { pending: 3 }, problems: [] } });
        expect(await screen.findByText('3 people are waiting for approval and cannot use AI yet.')).toBeInTheDocument();
    });

    it('is not rendered outside the users section', async () => {
        tab.section = 'groups';
        await renderPanel({ health: { health: 'blocked', users: { pending: 3 }, problems: [] } });
        await waitFor(() => expect(screen.queryByText('3 people are waiting for approval and cannot use AI yet.')).not.toBeInTheDocument());
    });
});
