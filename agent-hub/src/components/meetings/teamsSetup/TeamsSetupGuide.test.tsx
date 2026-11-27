import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import { renderWithClient } from '@/test/render';
import TeamsSetupGuide from './TeamsSetupGuide';

const fetchMock = vi.fn();
const answer = (body: unknown, status = 200) => ({
    ok: status >= 200 && status < 300, status,
    json: async () => body, text: async () => JSON.stringify(body),
    headers: new Headers({ 'content-type': 'application/json' }),
});

const REQUIREMENTS = {
    tenantMode: 'single',
    redirectUris: { signIn: 'https://flow.example/auth/callback/microsoft', connect: 'https://flow.example/api/integrations/microsoft/callback' },
    delegated: [
        { name: 'Calendars.ReadWrite', kind: 'delegated', option: 'A', role: 'required', adminConsent: false, purpose: 'calendar' },
        { name: 'OnlineMeetingRecording.Read.All', kind: 'delegated', option: 'A', role: 'required', adminConsent: true, purpose: 'recordings' },
        { name: 'Mail.Read', kind: 'delegated', option: 'A', role: 'requested', adminConsent: false, purpose: 'mail' },
    ],
    application: [
        { name: 'OnlineMeetings.Read.All', kind: 'application', option: 'B', role: 'required', adminConsent: true, purpose: 'meetings' },
    ],
};

const overview = (patch: Record<string, unknown> = {}) => ({
    windowDays: 7, generatedAt: '2026-11-10T10:00:00.000Z', truncated: false,
    settings: { autoImport: null, autoRecordConfig: null }, checks: [],
    totals: { members: 12, connected: 3, missingPermissions: 0, needsReauth: 0, skipped: 0, failedImports: 0 },
    members: [],
    ...patch,
});

const appImport = (patch: { enabled?: boolean; reason?: string; covered?: number } = {}) => ({
    settings: { enabled: patch.enabled ?? false, coverage: 'all', selectedUserIds: [], tenantId: null, enabledAt: null, enabledBy: null, updatedAt: null },
    availability: { reason: patch.reason ?? 'ok', tenantId: null, source: null },
    counts: { eligible: 12, covered: patch.covered ?? 0, withoutIdentity: 0, otherTenant: 0, withoutAccess: 0, notSelected: 0 },
});

interface Routes {
    requirements?: unknown;
    overview?: unknown;
    appImport?: unknown;
}

/** Answer each /api/teams-setup path the guide reads; a path left out is refused. */
function serve(routes: Routes) {
    fetchMock.mockImplementation(async (url: string) => {
        const u = String(url);
        if (u.endsWith('/api/teams-setup/requirements') && routes.requirements) return answer(routes.requirements);
        if (u.includes('/api/teams-setup/org/overview') && routes.overview) return answer(routes.overview);
        if (u.endsWith('/api/teams-setup/org/app-import') && routes.appImport) return answer(routes.appImport);
        return answer({ error: 'no' }, 403);
    });
}

beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
});

describe('TeamsSetupGuide', () => {
    it('names both ways in plain words, says who has to do what, and where to start', async () => {
        serve({ requirements: REQUIREMENTS });
        renderWithClient(<TeamsSetupGuide />);
        expect(screen.getByRole('heading', { name: 'Choose how Bee Flow reaches the meetings' })).toBeTruthy();

        const own = screen.getByTestId('teams-setup-option-a');
        expect(within(own).getByRole('heading', { name: 'Members connect their own account' })).toBeTruthy();
        expect(within(own).getByText('Start here')).toBeTruthy();
        expect(within(own).getByText('Connect Microsoft 365 once.')).toBeTruthy();
        expect(within(own).getByText(/approves the Teams permissions once/)).toBeTruthy();

        const org = screen.getByTestId('teams-setup-option-b');
        expect(within(org).getByRole('heading', { name: 'Organisation-wide import: nobody has to connect' })).toBeTruthy();
        expect(within(org).queryByText('Start here')).toBeNull();
        expect(within(org).getByText('Nothing, once they have signed in to Bee Flow with Microsoft.')).toBeTruthy();
        expect(within(org).getByText(/a Privileged Role Administrator approves the permissions/)).toBeTruthy();

        // Microsoft's own terms are not in the names of the ways.
        expect(screen.queryByText(/delegated permissions\)/)).toBeNull();
        expect(screen.queryByText(/application permissions\)/)).toBeNull();
    });

    it('keeps the setup steps folded away, with who does each one', async () => {
        serve({ requirements: REQUIREMENTS });
        renderWithClient(<TeamsSetupGuide />);
        const own = screen.getByTestId('teams-setup-option-a');
        const steps = within(own).getByText('Setup steps, and who does each one').closest('details') as HTMLDetailsElement;
        expect(steps.open).toBe(false);
        expect(within(steps).getByText(/Grant admin consent\. Use the admin consent link below/)).toBeTruthy();
        expect(within(steps).getByText('Microsoft Entra administrator')).toBeTruthy();
        expect(within(steps).getByText('Microsoft Teams administrator')).toBeTruthy();
        expect(within(steps).getByText('Each organiser')).toBeTruthy();
        // The last step says where the setting is, not "here".
        expect(within(steps).getByText(/in the Microsoft Teams settings of Meeting notes/)).toBeTruthy();

        const orgSteps = within(screen.getByTestId('teams-setup-option-b')).getByText('Setup steps, and who does each one').closest('details') as HTMLDetailsElement;
        expect(orgSteps.open).toBe(false);
        expect(within(orgSteps).getByText(/Create a Teams application access policy/)).toBeTruthy();
    });

    it('draws each way\'s own action inside its card', () => {
        serve({ requirements: REQUIREMENTS });
        renderWithClient(<TeamsSetupGuide consent={<p>the approval link</p>} appImport={<p>the organisation switch</p>} />);
        expect(within(screen.getByTestId('teams-setup-option-a')).getByText('the approval link')).toBeTruthy();
        expect(within(screen.getByTestId('teams-setup-option-b')).getByText('the organisation switch')).toBeTruthy();
    });

    it('shows where each way stands now: members connected, and organisation-wide import off', async () => {
        serve({ requirements: REQUIREMENTS, overview: overview(), appImport: appImport() });
        renderWithClient(<TeamsSetupGuide />);
        expect((await screen.findByTestId('teams-own-account-status')).textContent).toBe('3 of 12 members connected');
        expect((await screen.findByTestId('teams-org-import-status')).textContent).toBe('Off');
    });

    it('says organisation-wide import is on and how many members it covers', async () => {
        serve({ requirements: REQUIREMENTS, overview: overview(), appImport: appImport({ enabled: true, covered: 7 }) });
        renderWithClient(<TeamsSetupGuide />);
        expect((await screen.findByTestId('teams-org-import-status')).textContent).toBe('On, 7 members covered');
    });

    it('says organisation-wide import is not available yet when the server cannot offer it', async () => {
        serve({ requirements: REQUIREMENTS, overview: overview(), appImport: appImport({ reason: 'tenant_not_bound' }) });
        renderWithClient(<TeamsSetupGuide />);
        expect((await screen.findByTestId('teams-org-import-status')).textContent).toBe('Not available yet');
    });

    it('leaves the connected count out when the member list was cut short', async () => {
        serve({ requirements: REQUIREMENTS, overview: overview({ truncated: true }), appImport: appImport() });
        renderWithClient(<TeamsSetupGuide />);
        await screen.findByTestId('teams-org-import-status');
        expect(screen.queryByTestId('teams-own-account-status')).toBeNull();
    });

    it('says what is not supported and links to the full guide', () => {
        serve({ requirements: REQUIREMENTS });
        renderWithClient(<TeamsSetupGuide />);
        expect(screen.getByText(/Not supported/)).toBeTruthy();
        expect(screen.getByText(/Copilot notes are not supported/)).toBeTruthy();
        const docs = screen.getByRole('link', { name: /Read the full setup guide/ });
        expect(docs.getAttribute('href')).toBe('https://docs.beeflow.ai/integrations/teams-meeting-notes');
        expect(docs.getAttribute('rel')).toContain('noopener');
    });

    it('lists the permissions from the server with role, purpose and admin-consent mark, and both redirect URIs', async () => {
        serve({ requirements: REQUIREMENTS });
        renderWithClient(<TeamsSetupGuide />);
        const recordings = (await screen.findByText('OnlineMeetingRecording.Read.All')).closest('li') as HTMLElement;
        expect(within(recordings).getByText('Required')).toBeTruthy();
        expect(within(recordings).getByText('Meeting recordings')).toBeTruthy();
        expect(within(recordings).getByText('needs admin consent')).toBeTruthy();
        const calendar = screen.getByText('Calendars.ReadWrite').closest('li') as HTMLElement;
        expect(within(calendar).queryByText('needs admin consent')).toBeNull();
        expect(within(screen.getByText('Mail.Read').closest('li') as HTMLElement).getByText('Asked for by Bee Flow')).toBeTruthy();
        expect(within(screen.getByTestId('teams-setup-option-b')).getByText('OnlineMeetings.Read.All')).toBeTruthy();
        expect(screen.getByText('https://flow.example/auth/callback/microsoft')).toBeTruthy();
        expect(screen.getByText('https://flow.example/api/integrations/microsoft/callback')).toBeTruthy();
        expect(fetchMock.mock.calls.some(([url]) => /\/api\/teams-setup\/requirements$/.test(String(url)))).toBe(true);
    });

    it('without requirements (refused) the ways and steps still show, without permission lists or a status', async () => {
        serve({});
        renderWithClient(<TeamsSetupGuide />);
        expect(screen.getByRole('heading', { name: 'Members connect their own account' })).toBeTruthy();
        await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
        expect(screen.queryByText('Delegated permissions')).toBeNull();
        expect(screen.queryByText('Redirect URIs (Web)')).toBeNull();
        expect(screen.queryByTestId('teams-own-account-status')).toBeNull();
        expect(screen.queryByTestId('teams-org-import-status')).toBeNull();
    });
});
