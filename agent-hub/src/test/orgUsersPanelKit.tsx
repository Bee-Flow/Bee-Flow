// Shared set-up of the OrgUsersPanel suites (OrgUsersPanel.test.tsx and
// OrgUsersPanel.groups.test.tsx): the fixtures, an authFetch that answers from
// `state`, the record of every write, and the screen helpers. The suites mock
// '@/utils/helpers' themselves (authFetch is their vi.fn) and
// '@/hooks/useUrlTab' / Toast with ./orgUsersPanelMocks.
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import type { MockInstance } from 'vitest';
import { expect, vi } from 'vitest';
import OrgUsersPanel from '@/components/admin/org/OrgUsersPanel';
import { withQueryClient } from '@/test/render';
import { asMock } from '@/test/mocks';
import { authFetch } from '@/utils/helpers';
import { tab, toast } from './orgUsersPanelMocks';

type Row = Record<string, unknown>;
type Answer = Promise<unknown>;
type PanelUser = Parameters<typeof OrgUsersPanel>[0]['user'];

export const jsonRes = (body: unknown, status = 200): Answer => Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => 'application/json' },
    json: async () => body,
});

export const notJsonRes = (status = 502): Answer => Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => 'text/html' },
    json: async () => { throw new SyntaxError('Unexpected token < in JSON at position 0'); },
});

export const GROUPS: Row[] = [
    { id: 'g_fin', name: 'Finance', description: 'Finance team', organizationId: 'orgA' },
    { id: 'g_sup', name: 'Support', description: '', organizationId: 'orgA', orgRole: 'agent_admin' },
];

export const USERS: Row[] = [
    { id: 'u_admin', username: 'jan', displayName: 'Jan de Vries', email: 'jan@acme.nl', role: 'user', orgRole: 'org_admin', groups: ['g_fin'], organizationId: 'orgA', status: 'active' },
    { id: 'u_member', username: 'eva', displayName: 'Eva Bakker', email: 'eva@acme.nl', role: 'user', orgRole: 'member', groups: ['g_fin', 'g_sup'], organizationId: 'orgA', status: 'active' },
];

export const ADMIN = { id: 'u_admin', organizationId: 'orgA', groups: ['g_fin'], permissions: ['org_admin'] };
// The same person with the orgRole the panel checks before offering the role
// editor's toggles (canEditRoles reads orgRole / isAdmin, not permissions).
export const ORG_ADMIN = { ...ADMIN, orgRole: 'org_admin' };
// Nobody: no org role, no permissions, no organisation pointer.
export const NOBODY = { id: 'u_nobody', groups: [] };

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

export interface Write { url: string; method: string; body: unknown }

interface PanelState {
    users: Row[];
    groups: Row[];
    orgRoles: unknown;
    organizations: Row[];
    invitations: Row[];
    usage: Row[];
    customTiers: Row[];
    health: unknown;
    /** exact-url → { status, body } override for GETs */
    getOverrides: Record<string, { status?: number; body?: unknown; notJson?: boolean }>;
    /** every non-GET goes here; tests override to inject failures */
    write: (w: Write) => Answer;
    /** when set, authFetch rejects for every url */
    networkDown: boolean;
}

const state = {} as PanelState;

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
        getOverrides: {},
        write: () => jsonRes({ success: true }),
        networkDown: false,
    } satisfies PanelState);
};

/** The GET answers by exact address. */
const GETS: Record<string, () => Answer> = {
    '/auth/users?scope=admin': () => jsonRes(state.users),
    '/auth/groups?scope=admin': () => jsonRes(state.groups),
    '/auth/org-roles': () => jsonRes(state.orgRoles),
    '/auth/organizations?scope=admin': () => jsonRes(state.organizations),
    '/auth/invitations': () => jsonRes(state.invitations),
    '/api/usage/by-user?days=30': () => jsonRes(state.usage),
    '/ai/config/custom-tiers-list': () => jsonRes({ tiers: state.customTiers }),
    '/auth/admin/connector-health/mine': () => (state.health ? jsonRes(state.health) : jsonRes({}, 404)),
};

const installFetch = () => {
    asMock(authFetch).mockImplementation((url: string, opts: RequestInit = {}) => {
        if (state.networkDown) return Promise.reject(new Error('offline'));
        const method = (opts.method || 'GET').toUpperCase();
        const body = opts.body ? JSON.parse(String(opts.body)) : undefined;
        if (method !== 'GET') return state.write({ url, method, body });
        const override = state.getOverrides[url];
        if (override) return override.notJson ? notJsonRes(override.status) : jsonRes(override.body ?? {}, override.status);
        return Object.hasOwn(GETS, url) ? GETS[url]() : jsonRes({}, 404);
    });
};

/** Every write (non-GET) request the panel made, newest last. */
export const writes = (): Write[] => asMock(authFetch).mock.calls
    .filter(([, o]) => o && o.method && o.method !== 'GET')
    .map(([url, o]) => ({ url, method: o.method, body: o.body ? JSON.parse(o.body) : undefined }));

/** Render the panel once `overrides` are in the state, and wait for the first fetch. */
export const renderPanel = async (overrides: Partial<PanelState> = {}, currentUser: PanelUser = ADMIN) => {
    Object.assign(state, overrides);
    render(withQueryClient(<OrgUsersPanel user={currentUser} />));
    await waitFor(() => expect(screen.queryByTestId('user-list-skeleton')).not.toBeInTheDocument());
};

const closest = (text: string, selector: string): HTMLElement => {
    const el = screen.getByText(text).closest<HTMLElement>(selector);
    if (!el) throw new Error(`no ${selector} around "${text}"`);
    return el;
};
/** The member row for a person, by displayed name. */
export const row = (name: string) => closest(name, 'div.px-5');
/** The group card on the Groups tab, by group name. */
export const groupCard = (name: string) => closest(name, 'div.rounded-xl');
/** The button a text sits in (a tab, a role row). */
export const buttonOf = (text: string) => closest(text, 'button');

export interface PanelSpies {
    errorSpy: MockInstance;
    alertSpy: MockInstance;
    confirmSpy: MockInstance;
}

/** The beforeEach of both suites: users section, fresh state and fetch, quiet console, spied dialogs. */
export function resetPanel(): PanelSpies {
    cleanup();
    tab.section = 'users';
    tab.navigated = [];
    tab.basePath = null;
    asMock(authFetch).mockReset();
    resetState();
    installFetch();
    toast.error.mockReset();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    return {
        errorSpy: vi.spyOn(console, 'error').mockImplementation(() => {}),
        alertSpy: vi.spyOn(window, 'alert').mockImplementation(() => {}),
        confirmSpy: vi.spyOn(window, 'confirm').mockReturnValue(false),
    };
}
