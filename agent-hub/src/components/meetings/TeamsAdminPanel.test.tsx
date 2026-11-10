import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { renderWithClient } from '@/test/render';

const state: { query: unknown; save: { mutateAsync: ReturnType<typeof vi.fn>; isPending: boolean }; orgIds: unknown[] } = {
    query: null, save: { mutateAsync: vi.fn(), isPending: false }, orgIds: [],
};
vi.mock('../../api/queries/teamsMeetingNotes', () => ({
    useTeamsNotesOrgSettings: (orgId: unknown) => { state.orgIds.push(orgId); return state.query; },
    useSaveTeamsNotesOrgSettings: () => state.save,
}));

import TeamsAdminPanel from './TeamsAdminPanel';

const SAVED = { autoImport: false, autoRecordConfig: true, language: 'en', lookbackHours: 24, updatedAt: '2026-11-01T10:00:00.000Z', updatedBy: 'admin1' };
// What GET answers for an org that never saved: the server's built-in defaults, no stamp.
const NEVER_SAVED = { autoImport: false, autoRecordConfig: false, language: 'nl', lookbackHours: 24 };

// The setup sections read /api/teams-setup through the real query hooks; the network is stubbed.
const fetchMock = vi.fn();
const answer = (body: unknown, status = 200) => ({
    ok: status >= 200 && status < 300, status,
    json: async () => body, text: async () => JSON.stringify(body),
    headers: new Headers({ 'content-type': 'application/json' }),
});
const OVERVIEW = {
    windowDays: 7, generatedAt: '2026-11-10T10:00:00.000Z', truncated: false,
    settings: { autoImport: null, autoRecordConfig: null }, checks: [],
    totals: { members: 1, connected: 1, missingPermissions: 0, needsReauth: 0, skipped: 0, failedImports: 0 },
    members: [{ userId: 'u1', displayName: 'Member One', username: 'member1', meetingNotesAccess: true, microsoft: 'active', missingPermissions: [], teamsReady: true, verifiedMicrosoftIdentity: true, autoImportSkip: null, failures: [], appImportCovered: false }],
};
const APP_IMPORT = {
    settings: { enabled: false, coverage: 'selected', selectedUserIds: [], tenantId: null, enabledAt: null, enabledBy: null, updatedAt: null },
    availability: { reason: 'tenant_not_bound', tenantId: null, source: null },
    counts: { eligible: 1, covered: 0, withoutIdentity: 0, otherTenant: 0, withoutAccess: 0, notSelected: 1 },
};
function respond(url: string) {
    if (url.endsWith('/api/teams-setup/requirements')) return answer({ error: 'not licensed' }, 403);
    if (url.includes('/api/teams-setup/org/overview')) return answer(OVERVIEW);
    if (url.endsWith('/api/teams-setup/org/app-import')) return answer(APP_IMPORT);
    return answer({ error: 'unexpected' }, 404);
}

/** The org settings' Save button; organisation-wide import below has its own. */
function orgSaveOrNull(): HTMLElement | null {
    const appImport = screen.queryByTestId('teams-app-import');
    return screen.queryAllByRole('button', { name: 'Save' }).find((b) => !appImport?.contains(b)) ?? null;
}
function orgSave(): HTMLElement {
    const button = orgSaveOrNull();
    if (!button) throw new Error('no org settings Save button');
    return button;
}

describe('TeamsAdminPanel', () => {
    beforeEach(() => {
        cleanup();
        state.orgIds = [];
        state.save = { mutateAsync: vi.fn().mockResolvedValue({ ok: true }), isPending: false };
        state.query = { isLoading: false, data: SAVED };
        fetchMock.mockReset();
        fetchMock.mockImplementation(async (url: string) => respond(String(url)));
        vi.stubGlobal('fetch', fetchMock);
    });

    it('renders nothing without an organisation', () => {
        const { container } = renderWithClient(<TeamsAdminPanel user={{ organizationId: null }} />);
        expect(container.innerHTML).toBe('');
    });

    it('names the admin consent the Teams permissions need, and who grants it', () => {
        renderWithClient(<TeamsAdminPanel user={{ organizationId: 'orgA' }} />);
        expect(screen.getByText(/An Entra administrator must grant admin consent for OnlineMeetingRecording\.Read\.All and OnlineMeetingTranscript\.Read\.All/)).toBeTruthy();
        expect(state.orgIds).toContain('orgA');
    });

    it('mounts the setup guide, the consent link, the connection test and the members overview', async () => {
        renderWithClient(<TeamsAdminPanel user={{ organizationId: 'orgA' }} />);
        expect(screen.getByTestId('teams-setup-guide')).toBeTruthy();
        expect(within(screen.getByTestId('teams-consent-link')).getByRole('button', { name: 'Make the link' })).toBeTruthy();
        expect(within(screen.getByTestId('teams-connection-test')).getByRole('button', { name: 'Test my connection' })).toBeTruthy();
        expect(await within(screen.getByTestId('teams-members-overview')).findByText('Member One')).toBeTruthy();
        const appImport = screen.getByTestId('teams-app-import');
        expect(await within(appImport).findByText('Your organisation is not linked to a Microsoft tenant yet.')).toBeTruthy();
        expect(within(appImport).getByRole('button', { name: 'Test organisation-wide import' })).toBeTruthy();
        // Nothing is posted until the admin asks for it.
        expect(fetchMock.mock.calls.every(([, init]) => !init || (init as RequestInit).method === undefined || (init as RequestInit).method === 'GET')).toBe(true);
    });

    it('still offers setup and testing when the org settings could not be loaded', () => {
        state.query = { isLoading: false, isError: true, data: undefined };
        renderWithClient(<TeamsAdminPanel user={{ organizationId: 'orgA' }} />);
        expect(screen.getByTestId('teams-setup-guide')).toBeTruthy();
        expect(screen.getByTestId('teams-connection-test')).toBeTruthy();
    });

    it('loads the org values and saves the change', async () => {
        const user = userEvent.setup();
        renderWithClient(<TeamsAdminPanel user={{ organizationId: 'orgA' }} />);
        expect((screen.getByRole('combobox', { name: 'Default language' }) as HTMLSelectElement).value).toBe('en');
        await user.selectOptions(screen.getByRole('combobox', { name: 'Auto-import recorded Teams meetings' }), 'on');
        await user.click(orgSave());
        expect(state.save.mutateAsync).toHaveBeenCalledWith(expect.objectContaining({ autoImport: true, autoRecordConfig: true, language: 'en' }));
        expect(await screen.findByText('Saved')).toBeTruthy();
    });

    it('names each setting by its row title', () => {
        renderWithClient(<TeamsAdminPanel user={{ organizationId: 'orgA' }} />);
        expect((screen.getByRole('combobox', { name: 'Auto-import recorded Teams meetings' }) as HTMLSelectElement).value).toBe('off');
        expect((screen.getByRole('combobox', { name: 'Switch on Teams recording for meetings members organise' }) as HTMLSelectElement).value).toBe('on');
        expect(screen.getByRole('combobox', { name: 'Default language' })).toBeTruthy();
    });

    it('keeps members\' auto-import when an org that never saved changes only the language', async () => {
        state.query = { isLoading: false, data: NEVER_SAVED };
        const user = userEvent.setup();
        renderWithClient(<TeamsAdminPanel user={{ organizationId: 'orgA' }} />);
        expect((screen.getByRole('combobox', { name: 'Auto-import recorded Teams meetings' }) as HTMLSelectElement).value).toBe('');
        await user.selectOptions(screen.getByRole('combobox', { name: 'Default language' }), 'en');
        await user.click(orgSave());
        expect(state.save.mutateAsync).toHaveBeenCalledWith(expect.objectContaining({ language: 'en', autoImport: null, autoRecordConfig: null, lookbackHours: null }));
    });

    it('hands a fixed setting back to the members as null', async () => {
        const user = userEvent.setup();
        renderWithClient(<TeamsAdminPanel user={{ organizationId: 'orgA' }} />);
        await user.selectOptions(screen.getByRole('combobox', { name: 'Switch on Teams recording for meetings members organise' }), '');
        await user.click(orgSave());
        expect(state.save.mutateAsync).toHaveBeenCalledWith(expect.objectContaining({ autoRecordConfig: null, autoImport: false, language: 'en' }));
    });

    it('offers no Save when the org settings could not be loaded', () => {
        state.query = { isLoading: false, isError: true, data: undefined };
        renderWithClient(<TeamsAdminPanel user={{ organizationId: 'orgA' }} />);
        expect(screen.getByRole('alert')).toBeTruthy();
        expect(orgSaveOrNull()).toBeNull();
    });
});
