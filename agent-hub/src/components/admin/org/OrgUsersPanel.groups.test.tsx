import { fireEvent, screen, waitFor, within, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { MockInstance } from 'vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { asMock } from '@/test/mocks';
import { tab, toast } from '@/test/orgUsersPanelMocks';
import { GROUPS, NOBODY, ORG_ADMIN, USERS, buttonOf, groupCard, jsonRes, renderPanel, resetPanel, row, writes, type Write } from '@/test/orgUsersPanelKit';
import { authFetch } from '@/utils/helpers';
/**
 * Characterisation suite for the Groups and Roles tabs of OrgUsersPanel, and
 * the group popover of a member row (split from OrgUsersPanel.test.tsx; the
 * shared set-up is @/test/orgUsersPanelKit). "(wrat)" and "(fail-open)" in a
 * test name lock in behaviour that is wrong or surprising on purpose.
 */

vi.mock('@/utils/helpers', () => ({ API_BASE: '', authFetch: vi.fn() }));
vi.mock('@/components/shared/Toast', () => import('@/test/orgUsersPanelMocks'));
vi.mock('@/hooks/useTranslation', () => import('@/test/useTranslationParamsMock'));
vi.mock('@/hooks/useUrlTab', () => import('@/test/orgUsersPanelMocks'));

let alertSpy: MockInstance;
let confirmSpy: MockInstance;

beforeEach(() => { ({ alertSpy, confirmSpy } = resetPanel()); });
afterEach(() => { vi.restoreAllMocks(); });

/** The popover's line for a group (its name, then its member count). */
const groupButton = (name: string) => screen.getAllByRole('button').find(b => b.textContent?.startsWith(name)) as HTMLElement;
/** A member line inside an expanded group card. */
const memberRow = (group: string, name: string) => within(groupCard(group)).getByText(name).closest<HTMLElement>('div.flex.items-center') as HTMLElement;

// ═══════════════════════════════════════════════════ group-assign popover ════

describe('OrgUsersPanel — group assignment popover', () => {
    const openPopover = (name: string) => fireEvent.click(within(row(name)).getByTitle('Assign groups'));

    it('lists org groups with the member ones checked and selected first', async () => {
        await renderPanel();
        openPopover('Jan de Vries');
        expect(screen.getByText('1 selected')).toBeInTheDocument();
        const rows = screen.getAllByRole('button')
            .filter(b => /^(Finance|Support)\d*$/.test(b.textContent ?? ''));
        // Finance (member of) sorts above Support; the trailing digit is the member count.
        expect(rows[0]?.textContent).toMatch(/^Finance/);
        // Only the group he is in carries the check mark.
        expect(rows.find(b => b.textContent?.startsWith('Finance'))?.querySelector('svg')).toBeTruthy();
        expect(rows.find(b => b.textContent?.startsWith('Support'))?.querySelector('svg')).toBeNull();
    });

    it('toggling a group PUTs the full new group array', async () => {
        await renderPanel();
        openPopover('Jan de Vries');
        await userEvent.click(groupButton('Support'));
        await waitFor(() => expect(writes()).toContainEqual({
            url: '/auth/users/u_admin', method: 'PUT', body: { groups: ['g_fin', 'g_sup'] },
        }));
    });

    it('removing the last group PUTs an empty array', async () => {
        await renderPanel();
        openPopover('Jan de Vries');
        await userEvent.click(groupButton('Finance'));
        await waitFor(() => expect(writes()).toContainEqual({
            url: '/auth/users/u_admin', method: 'PUT', body: { groups: [] },
        }));
    });

    it('a refused group change is silent — no error, checkbox unchanged (wrat)', async () => {
        await renderPanel({ write: () => jsonRes({ error: 'forbidden' }, 403) });
        openPopover('Jan de Vries');
        await userEvent.click(groupButton('Support'));
        await waitFor(() => expect(writes()).toHaveLength(1));
        expect(screen.getByText('1 selected')).toBeInTheDocument();
        expect(alertSpy).not.toHaveBeenCalled();
    });

    it('offers a create-group shortcut when the organisation has no groups', async () => {
        await renderPanel({ groups: [] });
        openPopover('Jan de Vries');
        expect(screen.getByText('No groups in this organisation yet.')).toBeInTheDocument();
        await userEvent.click(screen.getByText('Create New Group'));
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
        expect(screen.getAllByRole('button').filter(b => /^Group \d/.test(b.textContent ?? ''))).toHaveLength(1);
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
        await userEvent.click(within(groupCard('Bravo Secrets')).getByTitle('Delete group'));
        await userEvent.click(await screen.findByTestId('confirm-dialog-confirm'));
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
        expect(within(card).getByText('Azure AD')).toBeInTheDocument();
        expect(within(card).getByText('Managed')).toBeInTheDocument();
        expect(within(card).queryByTitle('Delete group')).not.toBeInTheDocument();
        expect(within(card).getByTitle('Edit group settings')).toBeInTheDocument();

        await userEvent.click(screen.getByText('Azure Sales'));
        const roleSelect = within(groupCard('Azure Sales')).getByDisplayValue('User (default)');
        expect(roleSelect).not.toBeDisabled();
        fireEvent.change(roleSelect, { target: { value: 'org_admin' } });
        await waitFor(() => expect(writes()).toContainEqual({
            url: '/auth/groups/g_az', method: 'PUT', body: { orgRole: 'org_admin' },
        }));
    });

    it('deleting a group asks in the app\'s own dialog and sends nothing when declined', async () => {
        await renderPanel();
        await userEvent.click(within(groupCard('Finance')).getByTitle('Delete group'));
        const dialog = await screen.findByRole('dialog', { name: 'Delete this group?' });
        expect(within(dialog).getByText('Users will be unassigned.')).toBeInTheDocument();
        expect(confirmSpy).not.toHaveBeenCalled();
        await userEvent.click(screen.getByTestId('confirm-dialog-cancel'));
        await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
        expect(writes()).toHaveLength(0);
    });

    it('deleting a group DELETEs it once confirmed', async () => {
        await renderPanel();
        await userEvent.click(within(groupCard('Finance')).getByTitle('Delete group'));
        await userEvent.click(await screen.findByTestId('confirm-dialog-confirm'));
        await waitFor(() => expect(writes()).toContainEqual({
            url: '/auth/groups/g_fin', method: 'DELETE', body: undefined,
        }));
    });

    it('creates a group and keeps the form open when the server refuses (wrat)', async () => {
        await renderPanel({ write: () => jsonRes({ error: 'nope' }, 400) });
        await userEvent.click(screen.getByText('Create New Group'));
        fireEvent.change(screen.getByPlaceholderText('Group name'), { target: { value: 'Legal' } });
        fireEvent.change(screen.getByPlaceholderText('Description (optional)'), { target: { value: 'Legal team' } });
        await userEvent.click(screen.getByText('Create'));
        await waitFor(() => expect(writes()).toContainEqual({
            url: '/auth/groups', method: 'POST', body: { name: 'Legal', description: 'Legal team', organizationId: 'orgA' },
        }));
        expect(screen.getByPlaceholderText('Group name')).toHaveValue('Legal');
        expect(screen.queryByText(/failed|error/i)).not.toBeInTheDocument();
    });

    it('only offers an organisation picker when more than one org came back', async () => {
        await renderPanel();
        await userEvent.click(screen.getByText('Create New Group'));
        expect(screen.queryByDisplayValue('Acme B.V.')).not.toBeInTheDocument();

        cleanup();
        await renderPanel({ organizations: [{ id: 'orgA', name: 'Acme B.V.' }, { id: 'orgB', name: 'Other BV' }] });
        await userEvent.click(screen.getByText('Create New Group'));
        expect(screen.getByDisplayValue('Acme B.V.')).toBeInTheDocument();
    });

    it('renames the group description inline', async () => {
        await renderPanel();
        await userEvent.click(within(groupCard('Finance')).getByTitle('Edit group settings'));
        const input = screen.getByDisplayValue('Finance team');
        fireEvent.change(input, { target: { value: 'All things money' } });
        fireEvent.keyDown(input, { key: 'Enter' });
        await waitFor(() => expect(writes()).toContainEqual({
            url: '/auth/groups/g_fin', method: 'PUT', body: { description: 'All things money' },
        }));
    });

    it('shows "Click to add description..." for a group without one', async () => {
        await renderPanel();
        await userEvent.click(screen.getByText('Support'));
        expect(within(groupCard('Support')).getByText('Click to add description...')).toBeInTheDocument();
    });

    it('reports the group role as inherited by every member', async () => {
        await renderPanel();
        await userEvent.click(screen.getByText('Support'));
        const card = groupCard('Support');
        expect(within(card).getByDisplayValue('Agent admin')).toBeInTheDocument();
        expect(within(card).getByText('All members inherit this role')).toBeInTheDocument();
    });
});

describe('OrgUsersPanel — group allowed tiers', () => {
    beforeEach(() => { tab.section = 'groups'; });

    it('reads an empty allowedTiers as "no restriction" — every tier permitted (fail-open by design)', async () => {
        await renderPanel();
        await userEvent.click(screen.getByText('Finance'));
        expect(within(groupCard('Finance')).getByText(/No restriction set: members can use every tier/)).toBeInTheDocument();
        expect(within(groupCard('Finance')).queryByText('Clear restrictions')).not.toBeInTheDocument();
    });

    it('clicking a tier pill restricts the group to just that tier', async () => {
        await renderPanel();
        await userEvent.click(screen.getByText('Finance'));
        await userEvent.click(within(groupCard('Finance')).getByRole('button', { name: '🧠 Thinking' }));
        await waitFor(() => expect(writes()).toContainEqual({
            url: '/auth/groups/g_fin', method: 'PUT', body: { allowedTiers: ['thinking'] },
        }));
    });

    it('summarises an existing restriction and offers to clear it', async () => {
        await renderPanel({ groups: [{ ...GROUPS[0], allowedTiers: ['fast', 'writer'] }] });
        await userEvent.click(screen.getByText('Finance'));
        const card = groupCard('Finance');
        expect(within(card).getByText(/2 tiers permitted/)).toBeInTheDocument();
        await userEvent.click(within(card).getByText('Clear restrictions'));
        await waitFor(() => expect(writes()).toContainEqual({
            url: '/auth/groups/g_fin', method: 'PUT', body: { allowedTiers: [] },
        }));
    });

    it('switching off the last permitted tier sends an empty list — read back as every tier (fail-open)', async () => {
        await renderPanel({ groups: [{ ...GROUPS[0], allowedTiers: ['fast'] }] });
        await userEvent.click(screen.getByText('Finance'));
        // Fast is the only permitted tier; clicking it off empties the list, and
        // an empty list means "no restriction — members can use every tier".
        await userEvent.click(within(groupCard('Finance')).getByRole('button', { name: '⚡ Fast' }));
        await waitFor(() => expect(writes()).toContainEqual({
            url: '/auth/groups/g_fin', method: 'PUT', body: { allowedTiers: [] },
        }));
    });

    it('renders custom tiers alongside the four standard ones', async () => {
        await renderPanel({ customTiers: [{ id: 'legal', label: 'Legal', icon: '⚖️' }] });
        await userEvent.click(screen.getByText('Finance'));
        expect(within(groupCard('Finance')).getByRole('button', { name: '⚖️ Legal' })).toBeInTheDocument();
    });

    it('reports a failed tier update through the toast', async () => {
        await renderPanel({ write: () => jsonRes({ error: 'boom' }, 500) });
        await userEvent.click(screen.getByText('Finance'));
        await userEvent.click(within(groupCard('Finance')).getByRole('button', { name: '⚡ Fast' }));
        await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Failed to update allowed tiers (500): boom'));
        expect(alertSpy).not.toHaveBeenCalled();
    });
});

describe('OrgUsersPanel — group members', () => {
    beforeEach(() => { tab.section = 'groups'; });

    it('lists the members of an expanded group', async () => {
        await renderPanel();
        await userEvent.click(screen.getByText('Finance'));
        const card = groupCard('Finance');
        expect(within(card).getByText('Jan de Vries')).toBeInTheDocument();
        expect(within(card).getByText('Eva Bakker')).toBeInTheDocument();
    });

    it('says so for an empty group', async () => {
        await renderPanel({ groups: [{ id: 'g_new', name: 'Empty', organizationId: 'orgA' }] });
        await userEvent.click(screen.getByText('Empty'));
        expect(screen.getByText('No members in this group')).toBeInTheDocument();
    });

    it('shows the GROUP role for every member when the group carries one, overriding their own (wrat)', async () => {
        await renderPanel();
        await userEvent.click(screen.getByText('Support'));
        const evaRow = memberRow('Support', 'Eva Bakker');
        // Eva is orgRole 'member', but Support carries agent_admin.
        expect(within(evaRow).getByText('Agent admin')).toBeInTheDocument();
    });

    it('reads the organisation role before the system role, as the member list does', async () => {
        await renderPanel({
            users: [{ id: 'u_admin', displayName: 'Jan de Vries', role: 'user', orgRole: 'org_admin', groups: ['g_fin'], organizationId: 'orgA', status: 'active' }],
        });
        await userEvent.click(screen.getByText('Finance'));
        const janRow = memberRow('Finance', 'Jan de Vries');
        expect(within(janRow).getByText('Organisation admin')).toBeInTheDocument();
        expect(within(janRow).queryByText('user')).not.toBeInTheDocument();
    });

    it('removes a member from the group immediately, with no confirmation (fail-open)', async () => {
        await renderPanel();
        await userEvent.click(screen.getByText('Finance'));
        const evaRow = memberRow('Finance', 'Eva Bakker');
        await userEvent.click(within(evaRow).getByTitle('Remove from group'));
        await waitFor(() => expect(writes()).toContainEqual({
            url: '/auth/groups/g_fin/members/u_member', method: 'DELETE', body: undefined,
        }));
        expect(confirmSpy).not.toHaveBeenCalled();
    });

    it('reports a refused removal through the toast', async () => {
        await renderPanel({ write: () => jsonRes({ error: 'Cannot remove the last admin' }, 409) });
        await userEvent.click(screen.getByText('Finance'));
        const evaRow = memberRow('Finance', 'Eva Bakker');
        await userEvent.click(within(evaRow).getByTitle('Remove from group'));
        await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Cannot remove the last admin'));
        expect(alertSpy).not.toHaveBeenCalled();
    });

    it('adds a member from the group view and POSTs the user id', async () => {
        await renderPanel({
            users: [...USERS, { id: 'u_new', displayName: 'Nina Nieuw', email: 'nina@acme.nl', groups: [], organizationId: 'orgA', status: 'active' }],
        });
        await userEvent.click(screen.getByText('Finance'));
        await userEvent.click(within(groupCard('Finance')).getByText('Add member'));
        await userEvent.click(screen.getByText('Nina Nieuw'));
        await waitFor(() => expect(writes()).toContainEqual({
            url: '/auth/groups/g_fin/members', method: 'POST', body: { userId: 'u_new' },
        }));
    });

    it('says everyone is already a member when there is no candidate left', async () => {
        await renderPanel();
        await userEvent.click(screen.getByText('Finance'));
        await userEvent.click(within(groupCard('Finance')).getByText('Add member'));
        expect(screen.getByText('Everyone is already a member')).toBeInTheDocument();
    });

    it('excludes candidates from another organisation', async () => {
        await renderPanel({
            users: [...USERS, { id: 'u_out', displayName: 'Outsider Inc', groups: [], organizationId: 'orgB', status: 'active' }],
        });
        await userEvent.click(screen.getByText('Finance'));
        await userEvent.click(within(groupCard('Finance')).getByText('Add member'));
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
        for (const name of ['Organisation admin', 'Data protection officer', 'ISMS internal auditor', 'Agent admin', 'Agent editor', 'Member']) {
            expect(screen.getByText(name)).toBeInTheDocument();
        }
        await userEvent.click(buttonOf('Agent editor'));
        expect(screen.getByText('No permissions could be read for this role.')).toBeInTheDocument();
    });

    it('counts the six roles it lists in the tab badge, whatever the server returned', async () => {
        // Used to count three hardcoded ids out of the system-role table, so
        // the header read "Roles 3" (or 0) above a list of six.
        await renderPanel({ getOverrides: { '/auth/org-roles': { status: 404, body: {} } } });
        expect(within(buttonOf('Roles')).getByText('6')).toBeInTheDocument();
    });

    it('shows how many users carry a role, counting orgRole only', async () => {
        await renderPanel({
            users: [
                ...USERS,
                { id: 'u2', displayName: 'Ans', orgRole: 'org_admin', groups: [] },
                { id: 'u3', displayName: 'Bas', role: 'org_admin', groups: [] },
            ],
        });
        const adminRow = buttonOf('Organisation admin');
        expect(within(adminRow).getByText('2 people')).toBeInTheDocument();
    });

    it('draws the permission chips from the server mapping, as the same neutral theme chip for every role', async () => {
        await renderPanel();
        // No role colour: every role's chips are the theme's neutral chip (dpo,
        // isms_auditor and member included).
        const dpoRow = buttonOf('Data protection officer');
        const chip = within(dpoRow).getByText('Compliance Center');
        expect(chip.style.color).toBe('');
        expect(chip.className).toContain('border-[var(--border-default)]');
        // The role marker id ('dpo') is a permission in the mapping but not a
        // capability to show a person.
        expect(within(dpoRow).queryByText('Dpo')).not.toBeInTheDocument();

        const adminRow = buttonOf('Organisation admin');
        expect(within(adminRow).getByText('Manage Users').className).toBe(chip.className);
    });

    it('expands a role to its permission descriptions, read-only for someone who may not edit roles', async () => {
        // ADMIN carries the org_admin PERMISSION but no orgRole, so the panel
        // offers no toggles: the whole grant is listed under "Permissions".
        await renderPanel();
        await userEvent.click(buttonOf('Agent editor'));
        expect(screen.getByText('Permissions')).toBeInTheDocument();
        expect(screen.getByText('Create, edit, delete and publish agents')).toBeInTheDocument();
        expect(screen.queryByTestId('role-perm-agent_editor-use_forms')).not.toBeInTheDocument();
    });

    it('lets an org admin switch the editable half and keeps the rest fixed', async () => {
        await renderPanel({}, ORG_ADMIN);
        await userEvent.click(buttonOf('Agent editor'));
        expect(screen.getByText('What this role may use')).toBeInTheDocument();
        expect(screen.getByTestId('role-perm-agent_editor-use_forms')).toBeChecked();
        expect(screen.getByTestId('role-perm-agent_editor-use_webpages')).not.toBeChecked();
        // admin_agents is not editable, so it is listed once, under the lock,
        // and never as a toggle.
        const fixedBox = screen.getByText('Fixed by this role').closest<HTMLElement>('div.rounded-lg') as HTMLElement;
        expect(within(fixedBox).getByText('All Agents')).toBeInTheDocument();
        expect(screen.queryByTestId('role-perm-agent_editor-admin_agents')).not.toBeInTheDocument();
    });

    it('saves the full editable choice per role and splices it into the chips without a refetch', async () => {
        await renderPanel({}, ORG_ADMIN);
        const editorRow = buttonOf('Agent editor');
        expect(within(editorRow).getByText('Forms')).toBeInTheDocument();
        await userEvent.click(editorRow);
        await userEvent.click(screen.getByTestId('role-perm-agent_editor-use_forms'));
        await userEvent.click(screen.getByTestId('role-save-agent_editor'));

        await waitFor(() => expect(writes()).toHaveLength(1));
        const [put] = writes() as [Write];
        expect(put.url).toBe('/auth/org-roles/agent_editor');
        expect(put.method).toBe('PUT');
        // The whole editable set, not a delta — and nothing outside it.
        expect((put.body as { permissions: string[] }).permissions.sort()).toEqual(
            ['manage_agents', 'manage_knowledge', 'manage_skills', 'use_automations', 'use_datatables', 'use_notebooks'],
        );
        await waitFor(() => expect(within(editorRow).queryByText('Forms')).not.toBeInTheDocument());
        // Only the one role moved, and the fetch count did not grow.
        expect(within(buttonOf('Member')).getByText('Forms')).toBeInTheDocument();
        expect(asMock(authFetch).mock.calls.filter(([u]) => u === '/auth/org-roles')).toHaveLength(1);
    });
});
