import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { renderWithClient } from '@/test/render';
import TeamsAppImportPanel from './TeamsAppImportPanel';

const fetchMock = vi.fn();
const answer = (body: unknown, status = 200) => ({
    ok: status >= 200 && status < 300, status,
    json: async () => body, text: async () => JSON.stringify(body),
    headers: new Headers({ 'content-type': 'application/json' }),
});

const TENANT = '11111111-2222-3333-4444-555555555555';

const appState = (patch: { settings?: Record<string, unknown>; availability?: Record<string, unknown> } = {}) => ({
    settings: { enabled: false, coverage: 'selected', selectedUserIds: [], tenantId: null, enabledAt: null, enabledBy: null, updatedAt: null, ...patch.settings },
    availability: { reason: 'ok', tenantId: TENANT, source: 'directory_binding', ...patch.availability },
    counts: { eligible: 3, covered: 1, withoutIdentity: 1, otherTenant: 0, withoutAccess: 1, notSelected: 0 },
});

const member = (patch: Record<string, unknown>) => ({
    userId: 'u1', displayName: 'Member One', username: 'member1', meetingNotesAccess: true, microsoft: 'none',
    missingPermissions: [], teamsReady: false, verifiedMicrosoftIdentity: true, autoImportSkip: null, failures: [],
    appImportCovered: false, ...patch,
});

const overview = (members: unknown[], autoImport: boolean | null = null) => ({
    windowDays: 7, generatedAt: '2026-11-10T10:00:00.000Z', truncated: false,
    settings: { autoImport, autoRecordConfig: null }, checks: [],
    totals: { members: members.length, connected: 0, missingPermissions: 0, needsReauth: 0, skipped: 0, failedImports: 0 },
    members,
});

const MEMBERS = [
    member({ userId: 'u1', displayName: 'Member One', appImportCovered: true }),
    member({ userId: 'u2', displayName: 'Member Two', appImportCovered: true }),
    member({ userId: 'u3', displayName: 'Member Three', verifiedMicrosoftIdentity: false, meetingNotesAccess: false }),
];

const REPORT = {
    level: 'org_app', ranAt: '2026-11-10T10:00:00.000Z', overall: 'fail',
    checks: [
        { id: 'b.access_policy', option: 'B', status: 'fail', code: 'application_access_policy_missing', params: { clientId: 'aaaaaaaa-0000-0000-0000-000000000000' }, remediation: 'teams_setup.fix.grant_access_policy', fixer: 'teams_admin', dependsOn: ['b.calendar'] },
    ],
};

interface Routes {
    state?: unknown;
    stateStatus?: number;
    members?: unknown[];
    autoImport?: boolean | null;
    put?: { body: unknown; status: number };
    diag?: { body: unknown; status: number };
}

/** Answer each /api/teams-setup path the panel reads or writes. */
function serve(routes: Routes) {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
        const u = String(url);
        const method = init?.method || 'GET';
        if (u.includes('/api/teams-setup/org/overview')) return answer(overview(routes.members ?? MEMBERS, routes.autoImport ?? null));
        if (u.endsWith('/api/teams-setup/org/app-import/diagnostics') && method === 'POST') return answer(routes.diag?.body ?? REPORT, routes.diag?.status ?? 200);
        if (u.endsWith('/api/teams-setup/org/app-import') && method === 'PUT') return answer(routes.put?.body ?? appState(), routes.put?.status ?? 200);
        if (u.endsWith('/api/teams-setup/org/app-import')) return answer(routes.state ?? appState(), routes.stateStatus ?? 200);
        return answer({ error: 'unexpected' }, 404);
    });
}

const callsTo = (suffix: string, method: string) => fetchMock.mock.calls.filter(([url, init]) =>
    String(url).endsWith(suffix) && ((init as RequestInit | undefined)?.method || 'GET') === method);
const bodyOf = (call: unknown[]) => JSON.parse(String((call[1] as RequestInit).body));

beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
});

describe('TeamsAppImportPanel', () => {
    it('shows why it is unavailable, who fixes it, and cannot be switched on', async () => {
        serve({ state: appState({ availability: { reason: 'tenant_not_bound', tenantId: null, source: null } }) });
        renderWithClient(<TeamsAppImportPanel />);
        expect(await screen.findByText('Not available yet.')).toBeTruthy();
        expect(screen.getByText('Your organisation is not linked to a Microsoft tenant yet.')).toBeTruthy();
        expect(screen.getByText(/links your organisation to its Microsoft tenant \(the directory sync binding\)/)).toBeTruthy();
        expect(screen.getByText('The Bee Flow platform administrator must fix this')).toBeTruthy();
        expect((screen.getByRole('checkbox', { name: 'Import Teams meetings for the whole organisation' }) as HTMLInputElement).disabled).toBe(true);
        expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(false);
    });

    it('an org that is unavailable but still switched on can switch it off', async () => {
        const user = userEvent.setup();
        serve({ state: appState({ settings: { enabled: true }, availability: { reason: 'instance_disabled', tenantId: null, source: null } }) });
        renderWithClient(<TeamsAppImportPanel />);
        expect(await screen.findByText('Organisation-wide import is switched off on this server.')).toBeTruthy();
        const toggle = screen.getByRole('checkbox', { name: 'Import Teams meetings for the whole organisation' }) as HTMLInputElement;
        expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
        expect(toggle.disabled).toBe(false);
        await user.click(toggle);
        await user.click(screen.getByRole('button', { name: 'Save' }));
        await vi.waitFor(() => expect(callsTo('/api/teams-setup/org/app-import', 'PUT')).toHaveLength(1));
        expect(bodyOf(callsTo('/api/teams-setup/org/app-import', 'PUT')[0])).toEqual({ enabled: false, coverage: 'selected', selectedUserIds: [] });
        // Switching off asks nothing.
        expect(screen.queryByRole('dialog')).toBeNull();
    });

    it('asks before switching on, and a cancel sends nothing', async () => {
        const user = userEvent.setup();
        serve({});
        renderWithClient(<TeamsAppImportPanel />);
        expect(await screen.findByText(`Microsoft tenant: ${TENANT}`)).toBeTruthy();
        await user.click(screen.getByRole('checkbox', { name: 'Import Teams meetings for the whole organisation' }));
        await user.click(screen.getByRole('button', { name: 'Save' }));
        const dialog = await screen.findByRole('dialog');
        expect(within(dialog).getByText(/read the calendars, recordings and transcripts of covered members/)).toBeTruthy();
        await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
        expect(callsTo('/api/teams-setup/org/app-import', 'PUT')).toHaveLength(0);
    });

    it('selected coverage sends the ticked member ids after the confirm', async () => {
        const user = userEvent.setup();
        serve({ put: { body: appState({ settings: { enabled: true, selectedUserIds: ['u1', 'u3'] } }), status: 200 } });
        renderWithClient(<TeamsAppImportPanel />);
        await screen.findByText('Choose members');
        expect(await screen.findByText('Member Three')).toBeTruthy();
        expect(screen.getByText('Not signed in with Microsoft')).toBeTruthy();
        await user.click(screen.getByRole('checkbox', { name: 'Import Teams meetings for the whole organisation' }));
        await user.click(screen.getByRole('checkbox', { name: /Member One/ }));
        await user.click(screen.getByRole('checkbox', { name: /Member Three/ }));
        await user.click(screen.getByRole('button', { name: 'Save' }));
        await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Confirm' }));
        expect(await screen.findByText('Saved')).toBeTruthy();
        const puts = callsTo('/api/teams-setup/org/app-import', 'PUT');
        expect(puts).toHaveLength(1);
        expect(bodyOf(puts[0])).toEqual({ enabled: true, coverage: 'selected', selectedUserIds: ['u1', 'u3'] });
    });

    it('all members coverage hides the picker and sends coverage all', async () => {
        const user = userEvent.setup();
        serve({ state: appState({ settings: { enabled: true, coverage: 'selected', selectedUserIds: ['u2'] } }) });
        renderWithClient(<TeamsAppImportPanel />);
        await screen.findByText('Choose members');
        await user.click(screen.getByRole('radio', { name: 'All members with Meeting Notes' }));
        expect(screen.queryByText('Choose members')).toBeNull();
        await user.click(screen.getByRole('button', { name: 'Save' }));
        await vi.waitFor(() => expect(callsTo('/api/teams-setup/org/app-import', 'PUT')).toHaveLength(1));
        expect(bodyOf(callsTo('/api/teams-setup/org/app-import', 'PUT')[0])).toEqual({ enabled: true, coverage: 'all', selectedUserIds: ['u2'] });
    });

    it.each([
        ['not_a_member', 400, 'Some selected people are not members of this organisation.'],
        ['too_many_selected', 400, 'Too many members are selected.'],
        ['app_import_unavailable', 409, 'Organisation-wide import cannot be switched on yet.'],
    ])('a refused save (%s) says why in words', async (code, status, text) => {
        const user = userEvent.setup();
        serve({ state: appState({ settings: { enabled: true } }), put: { body: { error: 'refused', code }, status } });
        renderWithClient(<TeamsAppImportPanel />);
        await user.click(await screen.findByRole('button', { name: 'Save' }));
        expect((await screen.findByRole('alert')).textContent).toBe(text);
    });

    it('shows the counts, and the hint when the organisation switched automatic import off', async () => {
        serve({ state: appState({ settings: { enabled: true } }), autoImport: false });
        renderWithClient(<TeamsAppImportPanel />);
        expect((await screen.findByTestId('teams-app-import-counts')).textContent)
            .toBe('1 covered. 1 not signed in with Microsoft, 0 from another tenant, 1 without Meeting Notes, 0 not selected.');
        expect(await screen.findByText(/Automatic import is off, so only meetings that members mark for recording are imported/)).toBeTruthy();
    });

    it('also warns when members decide (the default), and stays quiet when the organisation switched it on', async () => {
        // The per-user default is off and a covered member who never connected cannot mark a
        // meeting, so with the org value left to members nothing is imported for them until
        // they switch it on themselves.
        serve({ state: appState({ settings: { enabled: true } }), autoImport: null });
        const { unmount } = renderWithClient(<TeamsAppImportPanel />);
        expect(await screen.findByText(/Automatic import is not switched on for everyone\. Covered members who did not connect get nothing imported unless they switch it on in their own settings/)).toBeTruthy();
        unmount();
        serve({ state: appState({ settings: { enabled: true } }), autoImport: true });
        renderWithClient(<TeamsAppImportPanel />);
        // The probe list comes from the overview, so once it lists a member the overview is in.
        const probe = await screen.findByRole('combobox', { name: 'Test with member' });
        await within(probe).findByRole('option', { name: 'Member One' });
        expect(screen.queryByText(/Automatic import is (off|not switched on for everyone)/)).toBeNull();
    });

    it('tests with the chosen covered member and renders the checklist', async () => {
        const user = userEvent.setup();
        serve({ state: appState({ settings: { enabled: true } }) });
        renderWithClient(<TeamsAppImportPanel />);
        const probe = await screen.findByRole('combobox', { name: 'Test with member' });
        // Only covered members can be picked.
        expect(within(probe).getAllByRole('option').map((o) => o.textContent)).toEqual(['Member One', 'Member Two']);
        await user.selectOptions(probe, 'u2');
        await user.click(screen.getByRole('button', { name: 'Test organisation-wide import' }));
        expect(await screen.findByText('The Teams application access policy allows the app')).toBeTruthy();
        // The client ID the policy's -AppIds needs is named.
        expect(screen.getByText('No Teams application access policy allows the app (aaaaaaaa-0000-0000-0000-000000000000) for this member.')).toBeTruthy();
        expect(screen.getByText('A Microsoft Teams administrator must fix this')).toBeTruthy();
        const posts = callsTo('/api/teams-setup/org/app-import/diagnostics', 'POST');
        expect(posts).toHaveLength(1);
        expect(bodyOf(posts[0])).toEqual({ probeUserId: 'u2' });
    });

    it('without covered members the test sends no probe member, and a 429 says to wait', async () => {
        const user = userEvent.setup();
        serve({ members: [MEMBERS[2]], diag: { body: { error: 'wait', code: 'diagnostics_rate_limited' }, status: 429 } });
        renderWithClient(<TeamsAppImportPanel />);
        await screen.findByText('Member Three');
        expect(screen.queryByRole('combobox', { name: 'Test with member' })).toBeNull();
        await user.click(screen.getByRole('button', { name: 'Test organisation-wide import' }));
        expect((await screen.findByRole('alert')).textContent).toBe('Wait a few seconds before you test again.');
        expect(bodyOf(callsTo('/api/teams-setup/org/app-import/diagnostics', 'POST')[0])).toEqual({});
    });

    it('a state that cannot be read shows the panel as not available', async () => {
        serve({ state: { error: 'nope' }, stateStatus: 404 });
        renderWithClient(<TeamsAppImportPanel />);
        expect(await screen.findByText('Not available yet.')).toBeTruthy();
        expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
    });
});
