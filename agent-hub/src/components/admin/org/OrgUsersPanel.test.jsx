import { render, screen, fireEvent, waitFor, within, cleanup, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import OrgUsersPanel from './OrgUsersPanel';
import { authFetch } from '../../../utils/helpers';

/**
 * Characterisation suite for OrgUsersPanel — the org rights screen.
 *
 * 1476 lines, previously covered only by OrgUsersPanel.filters.test.jsx (the
 * member filter bar). This file pins the REST of today's behaviour before the
 * builder redesign touches it: who sees which control, what a missing or
 * unknown role renders as, what a failed fetch/write leaves on screen, and
 * which destructive actions ask first.
 *
 * These tests describe reality, warts included. Where a test name says "(wrat)"
 * or "(fail-open)" the assertion deliberately locks in behaviour that is wrong
 * or surprising — so the redesign has to change the test on purpose rather than
 * change the behaviour by accident.
 *
 * Mock style is inherited from OrgUsersPanel.filters.test.jsx (same authFetch /
 * useTranslation / useUrlTab shims) so the two files cannot drift apart.
 */

// useUrlTab is mocked, so the section under test is chosen here and every
// setActiveSection() call is recorded instead of touching history.
const tab = vi.hoisted(() => ({ section: 'users', navigated: [] }));

vi.mock('../../../utils/helpers', () => ({ API_BASE: '', authFetch: vi.fn() }));
const { toast } = vi.hoisted(() => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock('../../shared/Toast', () => ({ toast }));
vi.mock('../../../hooks/useTranslation', () => ({
    useTranslation: () => ({
        // Mirrors the real t(): key, optional string fallback, optional params.
        t: (key, fallbackOrParams, maybeParams) => {
            const params = typeof fallbackOrParams === 'object' ? fallbackOrParams : maybeParams;
            if (params && typeof fallbackOrParams === 'string') {
                return fallbackOrParams.replace(/\{(\w+)\}/g, (m, k) => (k in params ? String(params[k]) : m));
            }
            if (params) return `${key}:${JSON.stringify(params)}`;
            return typeof fallbackOrParams === 'string' ? fallbackOrParams : key;
        },
    }),
}));
vi.mock('../../../hooks/useUrlTab', () => ({
    useUrlTab: () => [tab.section, (v) => { tab.navigated.push(v); }],
}));
vi.mock('./OrgCustomTiersPanel', () => ({ default: () => <div data-testid="custom-tiers-panel" /> }));
vi.mock('../../integrations/nextcloud/NextcloudSyncPanel', () => ({
    default: ({ user }) => <div data-testid="nc-sync-panel">{user?.id}</div>,
}));

// ─────────────────────────────────────────────────────────── fixtures / api ──

const jsonRes = (body, status = 200) => Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => 'application/json' },
    json: async () => body,
});

const notJsonRes = (status = 502) => Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => 'text/html' },
    json: async () => { throw new SyntaxError('Unexpected token < in JSON at position 0'); },
});

const GROUPS = [
    { id: 'g_fin', name: 'Finance', description: 'Finance team', organizationId: 'orgA' },
    { id: 'g_sup', name: 'Support', description: '', organizationId: 'orgA', orgRole: 'agent_admin' },
];

const USERS = [
    { id: 'u_admin', username: 'jan', displayName: 'Jan de Vries', email: 'jan@acme.nl', role: 'user', orgRole: 'org_admin', groups: ['g_fin'], organizationId: 'orgA', status: 'active' },
    { id: 'u_member', username: 'eva', displayName: 'Eva Bakker', email: 'eva@acme.nl', role: 'user', orgRole: 'member', groups: ['g_fin', 'g_sup'], organizationId: 'orgA', status: 'active' },
];

const ADMIN = { id: 'u_admin', organizationId: 'orgA', groups: ['g_fin'], permissions: ['org_admin'] };
// The same person with the orgRole the panel checks before offering the role
// editor's toggles (canEditRoles reads orgRole / isAdmin, not permissions).
const ORG_ADMIN = { ...ADMIN, orgRole: 'org_admin' };

// What GET /auth/org-roles answers: orgRole → permission ids, already merged
// with the organisation's own choices, plus the half of them an org admin may
// switch. A trimmed mirror of server/config/orgRoles.json and the
// EDITABLE_PERMISSIONS list in server/auth/orgRolePolicy.js — the role marker
// ids ('dpo', …) are part of a real answer and must never render as a chip.
const ORG_ROLE_MAPPING = [
    { id: 'org_admin', permissions: ['org_admin', 'manage_users', 'manage_agents', 'manage_skills', 'manage_knowledge', 'manage_apps', 'page_settings', 'use_notebooks', 'admin_security', 'admin_compliance', 'admin_monitoring', 'use_datatables', 'manage_datatables', 'use_webpages', 'use_automations', 'use_approvals', 'use_apps', 'use_forms', 'use_solutions', 'use_meeting_notes'] },
    { id: 'dpo', permissions: ['dpo', 'page_settings', 'admin_compliance', 'admin_monitoring', 'use_approvals', 'use_apps', 'use_forms'] },
    { id: 'isms_auditor', permissions: ['isms_auditor', 'page_settings', 'admin_compliance', 'admin_monitoring', 'use_approvals', 'use_apps', 'use_forms'] },
    { id: 'agent_admin', permissions: ['agent_admin', 'manage_agents', 'manage_skills', 'manage_knowledge', 'manage_apps', 'use_notebooks', 'admin_agents', 'use_datatables', 'manage_datatables', 'use_automations', 'use_approvals', 'use_apps', 'use_forms'] },
    { id: 'agent_editor', permissions: ['agent_editor', 'manage_agents', 'manage_skills', 'manage_knowledge', 'use_notebooks', 'admin_agents', 'use_datatables', 'use_automations', 'use_forms'] },
    { id: 'member', permissions: ['member', 'use_notebooks', 'use_datatables', 'use_approvals', 'use_apps', 'use_forms'] },
];
const EDITABLE_PERMISSIONS = [
    'manage_agents', 'manage_skills', 'manage_knowledge', 'use_meeting_notes', 'use_automations',
    'use_datatables', 'manage_datatables', 'use_webpages', 'manage_apps', 'use_apps',
    'use_solutions', 'use_approvals', 'use_forms', 'use_notebooks',
];
// Nobody: no org role, no permissions, no organisation pointer.
const NOBODY = { id: 'u_nobody', groups: [] };

const state = {};

const resetState = () => {
    Object.assign(state, {
        users: USERS,
        groups: GROUPS,
        orgRoles: { roles: ORG_ROLE_MAPPING, editablePermissions: EDITABLE_PERMISSIONS },
        organizations: [{ id: 'orgA', name: 'Acme B.V.' }],
        invitations: [],
        usage: [],
        customTiers: [],
        health: null,
        /** exact-url → { status, body } override for GETs */
        getOverrides: {},
        /** every non-GET goes here; tests override to inject failures */
        write: () => jsonRes({ success: true }),
        /** when set, authFetch rejects for every url */
        networkDown: false,
    });
};

const installFetch = () => {
    authFetch.mockImplementation((url, opts = {}) => {
        if (state.networkDown) return Promise.reject(new Error('offline'));
        const method = (opts.method || 'GET').toUpperCase();
        const body = opts.body ? JSON.parse(opts.body) : undefined;
        if (method !== 'GET') return state.write({ url, method, body });

        const override = state.getOverrides[url];
        if (override) {
            return override.notJson ? notJsonRes(override.status) : jsonRes(override.body ?? {}, override.status);
        }
        if (url === '/auth/users') return jsonRes(state.users);
        if (url === '/auth/groups') return jsonRes(state.groups);
        if (url === '/auth/org-roles') return jsonRes(state.orgRoles);
        if (url === '/auth/organizations') return jsonRes(state.organizations);
        if (url === '/auth/invitations') return jsonRes(state.invitations);
        if (url === '/api/usage/by-user?days=30') return jsonRes(state.usage);
        if (url === '/ai/config/custom-tiers-list') return jsonRes({ tiers: state.customTiers });
        if (url === '/auth/admin/connector-health/mine') {
            return state.health ? jsonRes(state.health) : jsonRes({}, 404);
        }
        return jsonRes({}, 404);
    });
};

/** Every write (non-GET) request the panel made, newest last. */
const writes = () => authFetch.mock.calls
    .filter(([, o]) => o && o.method && o.method !== 'GET')
    .map(([url, o]) => ({ url, method: o.method, body: o.body ? JSON.parse(o.body) : undefined }));

const renderPanel = async (overrides = {}, currentUser = ADMIN) => {
    Object.assign(state, overrides);
    render(<OrgUsersPanel user={currentUser} />);
    await waitFor(() => expect(screen.queryByTestId('user-list-skeleton')).not.toBeInTheDocument());
};

/** The member row for a person, by displayed name. */
const row = (name) => screen.getByText(name).closest('div.px-5');
/** The group card on the Groups tab, by group name. */
const groupCard = (name) => screen.getByText(name).closest('div.rounded-xl');

let errorSpy;
let alertSpy;
let confirmSpy;

beforeEach(() => {
    cleanup();
    tab.section = 'users';
    tab.navigated = [];
    authFetch.mockReset();
    resetState();
    installFetch();
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    toast.error.mockReset();
    alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});
    confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
});

afterEach(() => {
    vi.restoreAllMocks();
});

// ══════════════════════════════════════════════════════════ loading / errors ══

describe('OrgUsersPanel — loading and failed fetches', () => {
    it('shows the user-list skeleton while the first fetch is in flight', () => {
        authFetch.mockImplementation(() => new Promise(() => {}));
        render(<OrgUsersPanel user={ADMIN} />);
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

    it('a 403 on /auth/users is indistinguishable from "no users yet" (wrat)', async () => {
        await renderPanel({ getOverrides: { '/auth/users': { status: 403, body: { error: 'forbidden' } } } });
        expect(screen.getByText('No users yet')).toBeInTheDocument();
        expect(screen.getByText('Manage Groups')).toBeInTheDocument();
    });

    it('keeps the Invite User button on a failed fetch, so an empty org still offers to invite', async () => {
        await renderPanel({ networkDown: true });
        expect(screen.getByText('Invite User')).toBeInTheDocument();
    });

    it('"Manage Groups" in the empty state navigates to the groups section', async () => {
        await renderPanel({ users: [] });
        fireEvent.click(screen.getByText('Manage Groups'));
        expect(tab.navigated).toContain('groups');
    });
});

// ══════════════════════════════════════════════════════ member list & roles ══

describe('OrgUsersPanel — member list rendering', () => {
    it('lists members with name, email and the org-role chip', async () => {
        await renderPanel();
        const jan = row('Jan de Vries');
        expect(within(jan).getByText('jan@acme.nl')).toBeInTheDocument();
        expect(within(jan).getByText('Organisation Admin')).toBeInTheDocument();
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
        const usersTab = screen.getByText('Users').closest('button');
        expect(within(usersTab).getByText('2')).toBeInTheDocument();
        // Filtering the list down to a single row leaves the badge at 2.
        fireEvent.change(screen.getByLabelText('Search by name or email…'), { target: { value: 'Eva' } });
        expect(screen.queryByText('Jan de Vries')).not.toBeInTheDocument();
        expect(within(usersTab).getByText('2')).toBeInTheDocument();
    });
});

describe('OrgUsersPanel — how a role is displayed (rights-sensitive)', () => {
    const only = (u) => ({ users: [u] });

    it('a user with NO role at all renders as a full member chip reading "user" (fail-open)', async () => {
        await renderPanel(only({ id: 'u_none', displayName: 'Noor Zonder', groups: [], status: 'active' }));
        expect(within(row('Noor Zonder')).getByText('user')).toBeInTheDocument();
    });

    it('an UNKNOWN role is printed verbatim in a neutral grey chip (fail-open)', async () => {
        await renderPanel(only({ id: 'u_x', displayName: 'Xander Onbekend', orgRole: 'superuser', groups: [], status: 'active' }));
        const chip = within(row('Xander Onbekend')).getByText('superuser');
        expect(chip).toBeInTheDocument();
        // Not the coloured chip a known role gets.
        expect(chip.className).toContain('bg-[var(--bg-tertiary)]');
    });

    it('legacy orgRole "admin" renders as an ordinary grey chip, not as Organisation Admin (fail-open)', async () => {
        await renderPanel(only({ id: 'u_legacy', displayName: 'Lea Legacy', orgRole: 'admin', role: 'admin', groups: [], status: 'active' }));
        expect(within(row('Lea Legacy')).getByText('admin')).toBeInTheDocument();
        expect(within(row('Lea Legacy')).queryByText('Organisation Admin')).not.toBeInTheDocument();
    });

    it('never shows a role inherited from a group — the chip is the personal role only (fail-open)', async () => {
        // Eva is in Support, and Support carries orgRole 'agent_admin' ("All
        // members inherit this role" in the group view). Her chip says Member.
        await renderPanel();
        const eva = row('Eva Bakker');
        expect(within(eva).getByText('Member')).toBeInTheDocument();
        expect(within(eva).queryByText('Agent Admin')).not.toBeInTheDocument();
    });

    it('prefers orgRole over the system role when a user has both (orgRole || role)', async () => {
        await renderPanel(only({ id: 'u_both', displayName: 'Bea Beide', role: 'admin', orgRole: 'member', groups: [], status: 'active' }));
        const r = row('Bea Beide');
        expect(within(r).getByText('Member')).toBeInTheDocument();
        expect(within(r).queryByText('admin')).not.toBeInTheDocument();
    });

    it('falls back to users.role when orgRole is missing (orgRole || role)', async () => {
        await renderPanel(only({ id: 'u_r', displayName: 'Rob Rol', role: 'agent_editor', groups: [], status: 'active' }));
        expect(within(row('Rob Rol')).getByText('Agent Editor')).toBeInTheDocument();
    });
});

// ═════════════════════════════════════════════════════════ role editing ══════

describe('OrgUsersPanel — changing a role', () => {
    const openRoleEditor = (name) => {
        fireEvent.click(within(row(name)).getByTitle('Change role'));
        return within(row(name)).getByRole('combobox');
    };

    it('offers both "User" and "Member" as separate options for the same thing (wrat)', async () => {
        await renderPanel();
        const select = openRoleEditor('Jan de Vries');
        const labels = within(select).getAllByRole('option').map(o => o.textContent);
        expect(labels).toEqual(['User', 'Organisation Admin', 'Data Protection Officer', 'ISMS Internal Auditor', 'Agent Admin', 'Agent Editor', 'Member']);
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
        fireEvent.click(banner.parentElement.querySelector('button'));
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
        fireEvent.click(screen.getByText('Yes, step down'));

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
        fireEvent.click(screen.getByText('Cancel'));
        await waitFor(() => expect(screen.queryByText('Give up your admin rights?')).not.toBeInTheDocument());
        expect(writes()).toHaveLength(1);
    });

    it('the X next to the role dropdown closes it without sending anything', async () => {
        await renderPanel();
        const select = openRoleEditor('Jan de Vries');
        const closeBtn = select.parentElement.querySelector('button');
        fireEvent.click(closeBtn);
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
        expect(within(r).queryByText('Organisation Admin')).not.toBeInTheDocument();
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
        fireEvent.click(within(row('Piet Jansen')).getByText('Approve'));
        await waitFor(() => expect(writes()).toContainEqual({
            url: '/auth/users/u_pending', method: 'PUT', body: { status: 'active', orgRole: 'user' },
        }));
        expect(confirmSpy).not.toHaveBeenCalled();
    });

    it('Reject asks in the app\'s own dialog first and sends nothing while it is declined', async () => {
        await renderPanel({ users: [PENDING] });
        fireEvent.click(within(row('Piet Jansen')).getByText('Reject'));
        const dialog = await screen.findByRole('dialog', { name: 'Reject and remove this user?' });
        expect(within(dialog).getByText('They can sign up again later.')).toBeInTheDocument();
        expect(confirmSpy).not.toHaveBeenCalled();
        fireEvent.click(screen.getByTestId('confirm-dialog-cancel'));
        await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
        expect(writes()).toHaveLength(0);
    });

    it('Reject DELETEs the account once confirmed', async () => {
        await renderPanel({ users: [PENDING] });
        fireEvent.click(within(row('Piet Jansen')).getByText('Reject'));
        fireEvent.click(await screen.findByTestId('confirm-dialog-confirm'));
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
        fireEvent.click(within(row('Eva Bakker')).getByTitle('Change role'));
        fireEvent.change(within(row('Eva Bakker')).getByRole('combobox'), { target: { value: 'org_admin' } });
        await waitFor(() => expect(writes()).toContainEqual({
            url: '/auth/users/u_member', method: 'PUT', body: { orgRole: 'org_admin' },
        }));
    });
});

// ═══════════════════════════════════════════════════════════ auto-approve ═══

describe('OrgUsersPanel — SSO auto-approve toggle', () => {
    const ssoOrg = (extra = {}) => ({
        organizations: [{ id: 'orgA', name: 'Acme B.V.', authMethod: 'google', ...extra }],
    });

    it('is hidden for a password org', async () => {
        await renderPanel({ organizations: [{ id: 'orgA', name: 'Acme B.V.', authMethod: 'password' }] });
        expect(screen.queryByText('org.auto_approve_sso')).not.toBeInTheDocument();
    });

    it('is hidden when the org has no authMethod at all', async () => {
        await renderPanel();
        expect(screen.queryByText('org.auto_approve_sso')).not.toBeInTheDocument();
    });

    it('appears for an SSO org and PUTs the flipped value', async () => {
        await renderPanel(ssoOrg());
        expect(screen.getByText('org.auto_approve_sso')).toBeInTheDocument();
        fireEvent.click(screen.getByText('org.auto_approve_sso').closest('div.flex.items-center.justify-between').querySelector('button'));
        await waitFor(() => expect(writes()).toContainEqual({
            url: '/auth/organizations/orgA', method: 'PUT', body: { autoApproveSSO: true },
        }));
    });

    it('flips optimistically and rolls back when the server refuses', async () => {
        await renderPanel({ ...ssoOrg({ autoApproveSSO: false }), write: () => jsonRes({ error: 'nope' }, 403) });
        const toggle = screen.getByText('org.auto_approve_sso').closest('div.flex.items-center.justify-between').querySelector('button');
        expect(toggle.className).toContain('bg-[var(--border-default)]');
        fireEvent.click(toggle);
        // Flipped before the server answered…
        expect(toggle.className).toContain('bg-[var(--accent-primary)]');
        // …and taken back once the PUT came back refused.
        await waitFor(() => expect(toggle.className).toContain('bg-[var(--border-default)]'));
    });

    it('targets organizations[0] when the viewer has no organizationId — an arbitrary org (fail-open)', async () => {
        await renderPanel({
            organizations: [
                { id: 'orgZ', name: 'Someone Else BV', authMethod: 'google' },
                { id: 'orgA', name: 'Acme B.V.', authMethod: 'password' },
            ],
        }, NOBODY);
        fireEvent.click(screen.getByText('org.auto_approve_sso').closest('div.flex.items-center.justify-between').querySelector('button'));
        await waitFor(() => expect(writes()).toContainEqual({
            url: '/auth/organizations/orgZ', method: 'PUT', body: { autoApproveSSO: true },
        }));
    });

    it('hides the toggle when the viewer\'s organizationId is not in the returned list (fails closed)', async () => {
        await renderPanel(
            { organizations: [{ id: 'orgZ', name: 'Other', authMethod: 'google' }] },
            { id: 'u_admin', organizationId: 'orgA', groups: [] },
        );
        expect(screen.queryByText('org.auto_approve_sso')).not.toBeInTheDocument();
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
        expect(screen.getByText('Send').closest('button')).toBeDisabled();
        fireEvent.change(email, { target: { value: 'new@acme.nl' } });
        expect(screen.getByText('Send').closest('button')).not.toBeDisabled();
    });

    it('POSTs the address and role, then reports delivery', async () => {
        await renderPanel({ write: () => jsonRes({ success: true, emailSent: true }) });
        openInvite();
        fireEvent.change(screen.getByPlaceholderText('colleague@example.com'), { target: { value: 'new@acme.nl' } });
        fireEvent.change(screen.getByDisplayValue('User'), { target: { value: 'agent_admin' } });
        fireEvent.click(screen.getByText('Send'));
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
        fireEvent.click(screen.getByText('Send'));
        const copy = await screen.findByText('Copy invite link');
        fireEvent.click(copy);
        expect(writeText).toHaveBeenCalledWith('https://beeflow.nl/invite/abc');
    });

    it('turns a seat-cap refusal into an upgrade link', async () => {
        await renderPanel({ write: () => jsonRes({ error: 'Seat cap reached', code: 'seat_cap_exceeded' }, 402) });
        openInvite();
        fireEvent.change(screen.getByPlaceholderText('colleague@example.com'), { target: { value: 'new@acme.nl' } });
        fireEvent.click(screen.getByText('Send'));
        expect(await screen.findByText('Seat cap reached')).toBeInTheDocument();
        expect(screen.getByText('View plans & upgrade').getAttribute('href')).toBe('/app/settings/organisation/license');
    });

    it('reports a non-JSON server reply as a network error (wrat)', async () => {
        await renderPanel({ write: () => notJsonRes(502) });
        openInvite();
        fireEvent.change(screen.getByPlaceholderText('colleague@example.com'), { target: { value: 'new@acme.nl' } });
        fireEvent.click(screen.getByText('Send'));
        expect(await screen.findByText('Network error — please try again')).toBeInTheDocument();
    });

    it('treats a 200 without success:true as a failure', async () => {
        await renderPanel({ write: () => jsonRes({ success: false, error: 'Domain not allowed' }) });
        openInvite();
        fireEvent.change(screen.getByPlaceholderText('colleague@example.com'), { target: { value: 'new@acme.nl' } });
        fireEvent.click(screen.getByText('Send'));
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
        const first = screen.getByText('a@acme.nl').closest('div.px-5');
        expect(within(first).getByText('Organisation Admin')).toBeInTheDocument();
        expect(within(first).getByText(/Invited by Jan · Expires/)).toBeInTheDocument();
        // role 'user' gets no chip at all
        const second = screen.getByText('b@acme.nl').closest('div.px-5');
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
        fireEvent.click(screen.getByTitle('Revoke invitation'));
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
        expect(within(row('Anna')).getByText('$142')).toBeInTheDocument();
        expect(within(row('Bram')).getByText('$3.46')).toBeInTheDocument();
        expect(within(row('Cees')).getByText('$0.012')).toBeInTheDocument();
        expect(within(row('Dana')).queryByText(/^\$/)).not.toBeInTheDocument();
    });

    it('stays silent when the usage endpoint fails', async () => {
        await renderPanel({ getOverrides: { '/api/usage/by-user?days=30': { status: 500 } } });
        expect(screen.getByText('Jan de Vries')).toBeInTheDocument();
        expect(screen.queryByText('admin.org_usage_cost_30d')).not.toBeInTheDocument();
    });
});

// ═══════════════════════════════════════════════════ group-assign popover ════

describe('OrgUsersPanel — group assignment popover', () => {
    const openPopover = (name) => fireEvent.click(within(row(name)).getByTitle('Assign groups'));

    it('lists org groups with the member ones checked and selected first', async () => {
        await renderPanel();
        openPopover('Jan de Vries');
        expect(screen.getByText('1 selected')).toBeInTheDocument();
        const rows = screen.getAllByRole('button')
            .filter(b => /^(Finance|Support)\d*$/.test(b.textContent));
        // Finance (member of) sorts above Support; the trailing digit is the member count.
        expect(rows[0].textContent).toMatch(/^Finance/);
        // Only the group he is in carries the check mark.
        expect(rows.find(b => b.textContent.startsWith('Finance')).querySelector('svg')).toBeTruthy();
        expect(rows.find(b => b.textContent.startsWith('Support')).querySelector('svg')).toBeNull();
    });

    it('toggling a group PUTs the full new group array', async () => {
        await renderPanel();
        openPopover('Jan de Vries');
        fireEvent.click(screen.getAllByRole('button').find(b => b.textContent.startsWith('Support')));
        await waitFor(() => expect(writes()).toContainEqual({
            url: '/auth/users/u_admin', method: 'PUT', body: { groups: ['g_fin', 'g_sup'] },
        }));
    });

    it('removing the last group PUTs an empty array', async () => {
        await renderPanel();
        openPopover('Jan de Vries');
        fireEvent.click(screen.getAllByRole('button').find(b => b.textContent.startsWith('Finance')));
        await waitFor(() => expect(writes()).toContainEqual({
            url: '/auth/users/u_admin', method: 'PUT', body: { groups: [] },
        }));
    });

    it('a refused group change is silent — no error, checkbox unchanged (wrat)', async () => {
        await renderPanel({ write: () => jsonRes({ error: 'forbidden' }, 403) });
        openPopover('Jan de Vries');
        fireEvent.click(screen.getAllByRole('button').find(b => b.textContent.startsWith('Support')));
        await waitFor(() => expect(writes()).toHaveLength(1));
        expect(screen.getByText('1 selected')).toBeInTheDocument();
        expect(alertSpy).not.toHaveBeenCalled();
    });

    it('offers a create-group shortcut when the organisation has no groups', async () => {
        await renderPanel({ groups: [] });
        openPopover('Jan de Vries');
        expect(screen.getByText('No groups in this organisation yet.')).toBeInTheDocument();
        fireEvent.click(screen.getByText('Create New Group'));
        expect(tab.navigated).toContain('groups');
    });

    it('only shows the search box above five groups', async () => {
        await renderPanel();
        openPopover('Jan de Vries');
        expect(screen.queryByPlaceholderText('Search groups…')).not.toBeInTheDocument();
        fireEvent.keyDown(document, { key: 'Escape' });

        cleanup();
        await renderPanel({
            groups: Array.from({ length: 6 }, (_, i) => ({ id: `g${i}`, name: `Group ${i}`, organizationId: 'orgA' })),
        });
        openPopover('Jan de Vries');
        const search = screen.getByPlaceholderText('Search groups…');
        fireEvent.change(search, { target: { value: 'group 4' } });
        expect(screen.getAllByRole('button').filter(b => /^Group \d/.test(b.textContent))).toHaveLength(1);
    });

    it('says so when the search matches nothing', async () => {
        await renderPanel({
            groups: Array.from({ length: 6 }, (_, i) => ({ id: `g${i}`, name: `Group ${i}`, organizationId: 'orgA' })),
        });
        openPopover('Jan de Vries');
        fireEvent.change(screen.getByPlaceholderText('Search groups…'), { target: { value: 'zzz' } });
        expect(screen.getByText('No groups match your search.')).toBeInTheDocument();
    });

    it('closes on Escape', async () => {
        await renderPanel();
        openPopover('Jan de Vries');
        expect(screen.getByText('1 selected')).toBeInTheDocument();
        fireEvent.keyDown(document, { key: 'Escape' });
        await waitFor(() => expect(screen.queryByText('1 selected')).not.toBeInTheDocument());
    });
});

// ═══════════════════════════════════════════════════════════ groups section ══

describe('OrgUsersPanel — groups section', () => {
    beforeEach(() => { tab.section = 'groups'; });

    it('lists the org groups with a member count', async () => {
        await renderPanel();
        expect(within(groupCard('Finance')).getByText(/2 members/)).toBeInTheDocument();
        expect(within(groupCard('Support')).getByText(/1 member$/)).toBeInTheDocument();
    });

    it('hides groups that have no organizationId — the client re-derives the group scope (wrat)', async () => {
        await renderPanel({ groups: [...GROUPS, { id: 'g_glob', name: 'Global Group', organizationId: null }] });
        expect(screen.queryByText('Global Group')).not.toBeInTheDocument();
    });

    it('shows no groups at all to a viewer without an organisation pointer (fails closed)', async () => {
        await renderPanel({}, NOBODY);
        expect(screen.getByText('No groups yet')).toBeInTheDocument();
    });

    it('opens another organisation\'s groups to a viewer who is in one of its groups (fail-open)', async () => {
        // getUserOrgIds() falls back to the orgs of the viewer's own groups, so a
        // single membership in orgB adds every orgB group to this screen — with
        // Edit, the role selector and Delete on them.
        await renderPanel(
            {
                groups: [
                    { id: 'g_b', name: 'Bravo Group', organizationId: 'orgB' },
                    { id: 'g_b2', name: 'Bravo Secrets', organizationId: 'orgB' },
                ],
            },
            { id: 'u_x', groups: ['g_b'] },
        );
        expect(screen.getByText('Bravo Group')).toBeInTheDocument();
        expect(screen.getByText('Bravo Secrets')).toBeInTheDocument();
        fireEvent.click(within(groupCard('Bravo Secrets')).getByTitle('Delete group'));
        fireEvent.click(await screen.findByTestId('confirm-dialog-confirm'));
        await waitFor(() => expect(writes()).toContainEqual({
            url: '/auth/groups/g_b2', method: 'DELETE', body: undefined,
        }));
    });

    it('marks the built-in groups as System and hides both Edit and Delete on them', async () => {
        await renderPanel({ groups: [...GROUPS, { id: 'admins', name: 'Administrators', organizationId: 'orgA' }] });
        const card = groupCard('Administrators');
        expect(within(card).getByText('System')).toBeInTheDocument();
        expect(within(card).queryByTitle('Edit group settings')).not.toBeInTheDocument();
        expect(within(card).queryByTitle('Delete group')).not.toBeInTheDocument();
        expect(within(groupCard('Finance')).getByTitle('Delete group')).toBeInTheDocument();
    });

    it('an Azure-synced group hides Delete but keeps Edit and the role selector (wrat)', async () => {
        await renderPanel({
            groups: [{ id: 'g_az', name: 'Azure Sales', organizationId: 'orgA', source: 'azure', lastSyncedAt: '2026-09-01T10:00:00Z' }],
        });
        const card = groupCard('Azure Sales');
        expect(within(card).getByText('🪟 Azure AD')).toBeInTheDocument();
        expect(within(card).getByText('Managed')).toBeInTheDocument();
        expect(within(card).queryByTitle('Delete group')).not.toBeInTheDocument();
        expect(within(card).getByTitle('Edit group settings')).toBeInTheDocument();

        fireEvent.click(screen.getByText('Azure Sales'));
        const roleSelect = within(groupCard('Azure Sales')).getByDisplayValue('User (default)');
        expect(roleSelect).not.toBeDisabled();
        fireEvent.change(roleSelect, { target: { value: 'org_admin' } });
        await waitFor(() => expect(writes()).toContainEqual({
            url: '/auth/groups/g_az', method: 'PUT', body: { orgRole: 'org_admin' },
        }));
    });

    it('deleting a group asks in the app\'s own dialog and sends nothing when declined', async () => {
        await renderPanel();
        fireEvent.click(within(groupCard('Finance')).getByTitle('Delete group'));
        const dialog = await screen.findByRole('dialog', { name: 'Delete this group?' });
        expect(within(dialog).getByText('Users will be unassigned.')).toBeInTheDocument();
        expect(confirmSpy).not.toHaveBeenCalled();
        fireEvent.click(screen.getByTestId('confirm-dialog-cancel'));
        await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
        expect(writes()).toHaveLength(0);
    });

    it('deleting a group DELETEs it once confirmed', async () => {
        await renderPanel();
        fireEvent.click(within(groupCard('Finance')).getByTitle('Delete group'));
        fireEvent.click(await screen.findByTestId('confirm-dialog-confirm'));
        await waitFor(() => expect(writes()).toContainEqual({
            url: '/auth/groups/g_fin', method: 'DELETE', body: undefined,
        }));
    });

    it('creates a group and keeps the form open when the server refuses (wrat)', async () => {
        await renderPanel({ write: () => jsonRes({ error: 'nope' }, 400) });
        fireEvent.click(screen.getByText('Create New Group'));
        fireEvent.change(screen.getByPlaceholderText('Group name'), { target: { value: 'Legal' } });
        fireEvent.change(screen.getByPlaceholderText('Description (optional)'), { target: { value: 'Legal team' } });
        fireEvent.click(screen.getByText('Create'));
        await waitFor(() => expect(writes()).toContainEqual({
            url: '/auth/groups', method: 'POST', body: { name: 'Legal', description: 'Legal team', organizationId: 'orgA' },
        }));
        expect(screen.getByPlaceholderText('Group name')).toHaveValue('Legal');
        expect(screen.queryByText(/failed|error/i)).not.toBeInTheDocument();
    });

    it('only offers an organisation picker when more than one org came back', async () => {
        await renderPanel();
        fireEvent.click(screen.getByText('Create New Group'));
        expect(screen.queryByDisplayValue('Acme B.V.')).not.toBeInTheDocument();

        cleanup();
        await renderPanel({ organizations: [{ id: 'orgA', name: 'Acme B.V.' }, { id: 'orgB', name: 'Other BV' }] });
        fireEvent.click(screen.getByText('Create New Group'));
        expect(screen.getByDisplayValue('Acme B.V.')).toBeInTheDocument();
    });

    it('renames the group description inline', async () => {
        await renderPanel();
        fireEvent.click(within(groupCard('Finance')).getByTitle('Edit group settings'));
        const input = screen.getByDisplayValue('Finance team');
        fireEvent.change(input, { target: { value: 'All things money' } });
        fireEvent.keyDown(input, { key: 'Enter' });
        await waitFor(() => expect(writes()).toContainEqual({
            url: '/auth/groups/g_fin', method: 'PUT', body: { description: 'All things money' },
        }));
    });

    it('shows "Click to add description..." for a group without one', async () => {
        await renderPanel();
        fireEvent.click(screen.getByText('Support'));
        expect(within(groupCard('Support')).getByText('Click to add description...')).toBeInTheDocument();
    });

    it('reports the group role as inherited by every member', async () => {
        await renderPanel();
        fireEvent.click(screen.getByText('Support'));
        const card = groupCard('Support');
        expect(within(card).getByDisplayValue('Agent Admin')).toBeInTheDocument();
        expect(within(card).getByText('All members inherit this role')).toBeInTheDocument();
    });
});

describe('OrgUsersPanel — group allowed tiers', () => {
    beforeEach(() => { tab.section = 'groups'; });

    it('reads an empty allowedTiers as "no restriction" — every tier permitted (fail-open by design)', async () => {
        await renderPanel();
        fireEvent.click(screen.getByText('Finance'));
        expect(within(groupCard('Finance')).getByText(/No restriction set: members can use every tier/)).toBeInTheDocument();
        expect(within(groupCard('Finance')).queryByText('Clear restrictions')).not.toBeInTheDocument();
    });

    it('clicking a tier pill restricts the group to just that tier', async () => {
        await renderPanel();
        fireEvent.click(screen.getByText('Finance'));
        fireEvent.click(within(groupCard('Finance')).getByRole('button', { name: '🧠 Thinking' }));
        await waitFor(() => expect(writes()).toContainEqual({
            url: '/auth/groups/g_fin', method: 'PUT', body: { allowedTiers: ['thinking'] },
        }));
    });

    it('summarises an existing restriction and offers to clear it', async () => {
        await renderPanel({ groups: [{ ...GROUPS[0], allowedTiers: ['fast', 'writer'] }] });
        fireEvent.click(screen.getByText('Finance'));
        const card = groupCard('Finance');
        expect(within(card).getByText(/2 tiers permitted/)).toBeInTheDocument();
        fireEvent.click(within(card).getByText('Clear restrictions'));
        await waitFor(() => expect(writes()).toContainEqual({
            url: '/auth/groups/g_fin', method: 'PUT', body: { allowedTiers: [] },
        }));
    });

    it('switching off the last permitted tier sends an empty list — read back as every tier (fail-open)', async () => {
        await renderPanel({ groups: [{ ...GROUPS[0], allowedTiers: ['fast'] }] });
        fireEvent.click(screen.getByText('Finance'));
        // Fast is the only permitted tier; clicking it off empties the list, and
        // an empty list means "no restriction — members can use every tier".
        fireEvent.click(within(groupCard('Finance')).getByRole('button', { name: '⚡ Fast' }));
        await waitFor(() => expect(writes()).toContainEqual({
            url: '/auth/groups/g_fin', method: 'PUT', body: { allowedTiers: [] },
        }));
    });

    it('renders custom tiers alongside the four standard ones', async () => {
        await renderPanel({ customTiers: [{ id: 'legal', label: 'Legal', icon: '⚖️' }] });
        fireEvent.click(screen.getByText('Finance'));
        expect(within(groupCard('Finance')).getByRole('button', { name: '⚖️ Legal' })).toBeInTheDocument();
    });

    it('reports a failed tier update through the toast', async () => {
        await renderPanel({ write: () => jsonRes({ error: 'boom' }, 500) });
        fireEvent.click(screen.getByText('Finance'));
        fireEvent.click(within(groupCard('Finance')).getByRole('button', { name: '⚡ Fast' }));
        await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Failed to update allowed tiers (500): boom'));
        expect(alertSpy).not.toHaveBeenCalled();
    });
});

describe('OrgUsersPanel — group members', () => {
    beforeEach(() => { tab.section = 'groups'; });

    it('lists the members of an expanded group', async () => {
        await renderPanel();
        fireEvent.click(screen.getByText('Finance'));
        const card = groupCard('Finance');
        expect(within(card).getByText('Jan de Vries')).toBeInTheDocument();
        expect(within(card).getByText('Eva Bakker')).toBeInTheDocument();
    });

    it('says so for an empty group', async () => {
        await renderPanel({ groups: [{ id: 'g_new', name: 'Empty', organizationId: 'orgA' }] });
        fireEvent.click(screen.getByText('Empty'));
        expect(screen.getByText('No members in this group')).toBeInTheDocument();
    });

    it('shows the GROUP role for every member when the group carries one, overriding their own (wrat)', async () => {
        await renderPanel();
        fireEvent.click(screen.getByText('Support'));
        const evaRow = within(groupCard('Support')).getByText('Eva Bakker').closest('div.flex.items-center');
        // Eva is orgRole 'member', but Support carries agent_admin.
        expect(within(evaRow).getByText('Agent Admin')).toBeInTheDocument();
    });

    it('prefers users.role over users.orgRole here — the reverse of the member list (wrat)', async () => {
        await renderPanel({
            users: [{ id: 'u_admin', displayName: 'Jan de Vries', role: 'user', orgRole: 'org_admin', groups: ['g_fin'], organizationId: 'orgA', status: 'active' }],
        });
        fireEvent.click(screen.getByText('Finance'));
        const janRow = within(groupCard('Finance')).getByText('Jan de Vries').closest('div.flex.items-center');
        expect(within(janRow).getByText('user')).toBeInTheDocument();
        expect(within(janRow).queryByText('Organisation Admin')).not.toBeInTheDocument();
    });

    it('removes a member from the group immediately, with no confirmation (fail-open)', async () => {
        await renderPanel();
        fireEvent.click(screen.getByText('Finance'));
        const evaRow = within(groupCard('Finance')).getByText('Eva Bakker').closest('div.flex.items-center');
        fireEvent.click(within(evaRow).getByTitle('Remove from group'));
        await waitFor(() => expect(writes()).toContainEqual({
            url: '/auth/groups/g_fin/members/u_member', method: 'DELETE', body: undefined,
        }));
        expect(confirmSpy).not.toHaveBeenCalled();
    });

    it('reports a refused removal through the toast', async () => {
        await renderPanel({ write: () => jsonRes({ error: 'Cannot remove the last admin' }, 409) });
        fireEvent.click(screen.getByText('Finance'));
        const evaRow = within(groupCard('Finance')).getByText('Eva Bakker').closest('div.flex.items-center');
        fireEvent.click(within(evaRow).getByTitle('Remove from group'));
        await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Cannot remove the last admin'));
        expect(alertSpy).not.toHaveBeenCalled();
    });

    it('adds a member from the group view and POSTs the user id', async () => {
        await renderPanel({
            users: [...USERS, { id: 'u_new', displayName: 'Nina Nieuw', email: 'nina@acme.nl', groups: [], organizationId: 'orgA', status: 'active' }],
        });
        fireEvent.click(screen.getByText('Finance'));
        fireEvent.click(within(groupCard('Finance')).getByText('Add member'));
        fireEvent.click(screen.getByText('Nina Nieuw'));
        await waitFor(() => expect(writes()).toContainEqual({
            url: '/auth/groups/g_fin/members', method: 'POST', body: { userId: 'u_new' },
        }));
    });

    it('says everyone is already a member when there is no candidate left', async () => {
        await renderPanel();
        fireEvent.click(screen.getByText('Finance'));
        fireEvent.click(within(groupCard('Finance')).getByText('Add member'));
        expect(screen.getByText('Everyone is already a member')).toBeInTheDocument();
    });

    it('excludes candidates from another organisation', async () => {
        await renderPanel({
            users: [...USERS, { id: 'u_out', displayName: 'Outsider Inc', groups: [], organizationId: 'orgB', status: 'active' }],
        });
        fireEvent.click(screen.getByText('Finance'));
        fireEvent.click(within(groupCard('Finance')).getByText('Add member'));
        expect(screen.getByText('Everyone is already a member')).toBeInTheDocument();
    });
});

// ═══════════════════════════════════════════════════════════ roles section ═══

describe('OrgUsersPanel — roles section', () => {
    beforeEach(() => { tab.section = 'roles'; });

    // The list itself is the six ORG_ROLES; what each one GRANTS comes from
    // GET /auth/org-roles (the resolver's own answer, merged with the org's
    // choices) rather than from a hand-kept description that had drifted.
    // An older server without the route still gets the six rows — and an
    // honest "could not read" under each, never an invented list.

    it('always renders the six hard-coded ORG_ROLES, even when /auth/org-roles is missing', async () => {
        await renderPanel({ getOverrides: { '/auth/org-roles': { status: 404, body: {} } } });
        for (const name of ['Organisation Admin', 'Data Protection Officer', 'ISMS Internal Auditor', 'Agent Admin', 'Agent Editor', 'Member']) {
            expect(screen.getByText(name)).toBeInTheDocument();
        }
        fireEvent.click(screen.getByText('Agent Editor').closest('button'));
        expect(screen.getByText('No permissions could be read for this role.')).toBeInTheDocument();
    });

    it('counts the six roles it lists in the tab badge, whatever the server returned', async () => {
        // Used to count three hardcoded ids out of the system-role table, so
        // the header read "Roles 3" (or 0) above a list of six.
        await renderPanel({ getOverrides: { '/auth/org-roles': { status: 404, body: {} } } });
        expect(within(screen.getByText('Roles').closest('button')).getByText('6')).toBeInTheDocument();
    });

    it('shows how many users carry a role, counting orgRole only', async () => {
        await renderPanel({
            users: [
                ...USERS,
                { id: 'u2', displayName: 'Ans', orgRole: 'org_admin', groups: [] },
                { id: 'u3', displayName: 'Bas', role: 'org_admin', groups: [] },
            ],
        });
        const adminRow = screen.getByText('Organisation Admin').closest('button');
        expect(within(adminRow).getByText('2 users')).toBeInTheDocument();
    });

    it('draws the permission chips from the server mapping, tinted with the role colour', async () => {
        await renderPanel();
        // Every role's chips carry its own colour now — dpo, isms_auditor and
        // member used to fall outside a three-role lookup and render unstyled.
        const dpoRow = screen.getByText('Data Protection Officer').closest('button');
        const chip = within(dpoRow).getByText('Compliance Center');
        expect(chip.style.color).toBe('rgb(59, 130, 246)');
        // The role marker id ('dpo') is a permission in the mapping but not a
        // capability to show a person.
        expect(within(dpoRow).queryByText('Dpo')).not.toBeInTheDocument();

        const adminRow = screen.getByText('Organisation Admin').closest('button');
        expect(within(adminRow).getByText('Manage Users').style.color).toBe('rgb(139, 92, 246)');
    });

    it('expands a role to its permission descriptions, read-only for someone who may not edit roles', async () => {
        // ADMIN carries the org_admin PERMISSION but no orgRole, so the panel
        // offers no toggles: the whole grant is listed under "Permissions".
        await renderPanel();
        fireEvent.click(screen.getByText('Agent Editor').closest('button'));
        expect(screen.getByText('Permissions')).toBeInTheDocument();
        expect(screen.getByText('Create, edit, delete and publish agents')).toBeInTheDocument();
        expect(screen.queryByTestId('role-perm-agent_editor-use_forms')).not.toBeInTheDocument();
    });

    it('lets an org admin switch the editable half and keeps the rest fixed', async () => {
        await renderPanel({}, ORG_ADMIN);
        fireEvent.click(screen.getByText('Agent Editor').closest('button'));
        expect(screen.getByText('What this role may use')).toBeInTheDocument();
        expect(screen.getByTestId('role-perm-agent_editor-use_forms').checked).toBe(true);
        expect(screen.getByTestId('role-perm-agent_editor-use_webpages').checked).toBe(false);
        // admin_agents is not editable, so it is listed once, under the lock,
        // and never as a toggle.
        const fixedBox = screen.getByText('Fixed by this role').closest('div.rounded-lg');
        expect(within(fixedBox).getByText('All Agents')).toBeInTheDocument();
        expect(screen.queryByTestId('role-perm-agent_editor-admin_agents')).not.toBeInTheDocument();
    });

    it('saves the full editable choice per role and splices it into the chips without a refetch', async () => {
        await renderPanel({}, ORG_ADMIN);
        const editorRow = screen.getByText('Agent Editor').closest('button');
        expect(within(editorRow).getByText('Forms')).toBeInTheDocument();
        fireEvent.click(editorRow);
        fireEvent.click(screen.getByTestId('role-perm-agent_editor-use_forms'));
        fireEvent.click(screen.getByTestId('role-save-agent_editor'));

        await waitFor(() => expect(writes()).toHaveLength(1));
        const [put] = writes();
        expect(put.url).toBe('/auth/org-roles/agent_editor');
        expect(put.method).toBe('PUT');
        // The whole editable set, not a delta — and nothing outside it.
        expect(put.body.permissions.sort()).toEqual(
            ['manage_agents', 'manage_knowledge', 'manage_skills', 'use_automations', 'use_datatables', 'use_notebooks'],
        );
        await waitFor(() => expect(within(editorRow).queryByText('Forms')).not.toBeInTheDocument());
        // Only the one role moved, and the fetch count did not grow.
        expect(within(screen.getByText('Member').closest('button')).getByText('Forms')).toBeInTheDocument();
        expect(authFetch.mock.calls.filter(([u]) => u === '/auth/org-roles')).toHaveLength(1);
    });
});

// ═════════════════════════════════════════════════════════ sections / tabs ═══

describe('OrgUsersPanel — sections', () => {
    it('renders three tabs for a normal org', async () => {
        await renderPanel();
        expect(screen.getByText('Users')).toBeInTheDocument();
        expect(screen.getByText('Groups')).toBeInTheDocument();
        expect(screen.getByText('Roles')).toBeInTheDocument();
        expect(screen.queryByText('Nextcloud Sync')).not.toBeInTheDocument();
    });

    it('adds a Nextcloud Sync tab only for an ncOrg', async () => {
        await renderPanel({}, { ...ADMIN, ncOrg: { instanceId: 'nc1' } });
        expect(screen.getByText('Nextcloud Sync')).toBeInTheDocument();
    });

    it('renders the Nextcloud panel only when the viewer is an ncOrg — otherwise nothing (fails closed)', async () => {
        tab.section = 'sync';
        await renderPanel();
        expect(screen.queryByTestId('nc-sync-panel')).not.toBeInTheDocument();

        cleanup();
        await renderPanel({}, { ...ADMIN, ncOrg: { instanceId: 'nc1' } });
        expect(screen.getByTestId('nc-sync-panel')).toBeInTheDocument();
    });

    it('renders the custom-tiers panel for a section that has no tab to reach it (wrat)', async () => {
        tab.section = 'customTiers';
        await renderPanel();
        expect(screen.getByTestId('custom-tiers-panel')).toBeInTheDocument();
        expect(screen.queryByText('Custom Tiers')).not.toBeInTheDocument();
    });

    it('switching tab records the new section', async () => {
        await renderPanel();
        fireEvent.click(screen.getByText('Roles').closest('button'));
        expect(tab.navigated).toContain('roles');
    });
});

// ═══════════════════════════════════════════════════════════ health banner ══

describe('OrgUsersPanel — org health banner', () => {
    it('stays silent when the health endpoint 404s', async () => {
        await renderPanel();
        // Let the failed health round trip land — a banner would be on screen by now.
        await act(async () => { await new Promise(r => setTimeout(r, 0)); });
        expect(screen.getByText('Organisation Members')).toBeInTheDocument();
        expect(screen.queryByText(/waiting for approval/)).not.toBeInTheDocument();
    });

    it('surfaces pending approvals above the member list', async () => {
        await renderPanel({ health: { health: 'blocked', users: { pending: 3 }, problems: [] } });
        expect(await screen.findByText('3 user(s) are waiting for approval and cannot use AI yet.')).toBeInTheDocument();
    });

    it('is not rendered outside the users section', async () => {
        tab.section = 'groups';
        await renderPanel({ health: { health: 'blocked', users: { pending: 3 }, problems: [] } });
        await waitFor(() => expect(screen.queryByText('3 user(s) are waiting for approval and cannot use AI yet.')).not.toBeInTheDocument());
    });
});
