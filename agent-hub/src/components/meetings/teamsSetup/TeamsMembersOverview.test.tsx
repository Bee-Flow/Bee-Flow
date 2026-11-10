import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { renderWithClient } from '@/test/render';
import TeamsMembersOverview from './TeamsMembersOverview';

const fetchMock = vi.fn();
const answer = (body: unknown, status = 200) => ({
    ok: status >= 200 && status < 300, status,
    json: async () => body, text: async () => JSON.stringify(body),
    headers: new Headers({ 'content-type': 'application/json' }),
});

const member = (patch: Record<string, unknown>) => ({
    userId: 'u1', displayName: 'Member One', username: 'member1', meetingNotesAccess: true, microsoft: 'active',
    missingPermissions: [], teamsReady: true, verifiedMicrosoftIdentity: true, autoImportSkip: null, failures: [],
    appImportCovered: false, ...patch,
});

const overview = (patch: Record<string, unknown> = {}) => ({
    windowDays: 7, generatedAt: '2026-11-10T10:00:00.000Z', truncated: false,
    settings: { autoImport: null, autoRecordConfig: null },
    checks: [
        { id: 'org.consent_link', option: 'A', status: 'pass', code: 'ok', params: {}, remediation: null, fixer: null, dependsOn: [] },
        { id: 'org.admin_consent', option: 'A', status: 'unknown', code: 'consent_not_recorded', params: {}, remediation: 'teams_setup.fix.open_consent_link', fixer: 'entra_admin', dependsOn: [] },
    ],
    totals: { members: 3, connected: 2, missingPermissions: 1, needsReauth: 1, skipped: 1, failedImports: 3 },
    members: [
        member({ userId: 'u1' }),
        member({ userId: 'u2', displayName: null, username: 'member2', missingPermissions: ['OnlineMeetingRecording.Read.All'], teamsReady: false, failures: [{ code: 'graph_forbidden', count: 2 }, { code: 'meeting_not_available', count: 1 }] }),
        member({
            userId: 'u3', displayName: 'Member Three', microsoft: 'needs_reauth', teamsReady: false, meetingNotesAccess: false, verifiedMicrosoftIdentity: false,
            autoImportSkip: { reason: 'credential_needs_reauth', missingPermissions: [], at: '2026-11-10T09:00:00.000Z' },
            // Fields the row type does not have must never reach the screen.
            email: 'member@fixture.test', azureUserId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', scope: 'fixture-scope-string',
        }),
    ],
    ...patch,
});

beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
});

const rowOf = (userId: string) => document.querySelector(`tr[data-user-id="${userId}"]`) as HTMLElement;

describe('TeamsMembersOverview', () => {
    it('renders the org checks, the totals and one row per member', async () => {
        fetchMock.mockResolvedValue(answer(overview()));
        renderWithClient(<TeamsMembersOverview />);
        expect(await screen.findByText('Member One')).toBeTruthy();
        expect(screen.getByText('An admin consent link can be made')).toBeTruthy();
        expect(screen.getByText('Admin consent was recorded')).toBeTruthy();
        expect(screen.getByTestId('teams-members-totals').textContent)
            .toBe('2 of 3 connected, 1 missing permissions, 1 expired, 1 skipped, 3 failed imports');

        const one = rowOf('u1');
        expect(within(one).getByText('Connected')).toBeTruthy();
        // The org leaves automatic import to members, and the row has no per-member value.
        expect(within(one).queryByText('Runs')).toBeNull();
        expect(within(one).getByText("Depends on the member's own setting")).toBeTruthy();
        expect(within(one).getAllByText('None')).toHaveLength(2);

        const two = rowOf('u2');
        expect(within(two).getByText('member2')).toBeTruthy();
        expect(within(two).getByText('OnlineMeetingRecording.Read.All')).toBeTruthy();
        expect(within(two).getByText(/Microsoft refused access to this meeting.*\(2\)$/)).toBeTruthy();
        expect(within(two).getByText(/no online meeting for this calendar entry.*\(1\)$/)).toBeTruthy();

        const three = rowOf('u3');
        expect(within(three).getByText('Expired')).toBeTruthy();
        expect(within(three).getByText('Skipped: the stored Microsoft 365 connection has expired.')).toBeTruthy();
        expect(within(three).getByText('No Meeting Notes access')).toBeTruthy();
        expect(within(three).getByText('Not signed in with Microsoft')).toBeTruthy();
    });

    it('marks a member covered by organisation-wide import, whose import then runs without a connection', async () => {
        fetchMock.mockResolvedValue(answer(overview({
            settings: { autoImport: true, autoRecordConfig: null },
            members: [
                member({ userId: 'u4', displayName: 'Member Four', microsoft: 'none', teamsReady: false, appImportCovered: true }),
                member({ userId: 'u5', displayName: 'Member Five', microsoft: 'none', teamsReady: false }),
            ],
        })));
        renderWithClient(<TeamsMembersOverview />);
        await screen.findByText('Member Four');
        const four = rowOf('u4');
        expect(within(four).getByText('Covered by organisation-wide import')).toBeTruthy();
        expect(within(four).getByText('Runs')).toBeTruthy();
        const five = rowOf('u5');
        expect(within(five).queryByText('Covered by organisation-wide import')).toBeNull();
        expect(within(five).queryByText('Runs')).toBeNull();
    });

    it.each([
        // The poller never looks at a member whose automatic import is off, so a ready or
        // covered member only "runs" when the organisation switched it on for everyone.
        [true, 'Runs'],
        [false, 'Off'],
        [null, "Depends on the member's own setting"],
    ])('with the organisation value %s a ready and a covered member read "%s"', async (autoImport, text) => {
        fetchMock.mockResolvedValue(answer(overview({
            settings: { autoImport, autoRecordConfig: null },
            members: [
                member({ userId: 'u1' }),
                member({ userId: 'u4', displayName: 'Member Four', microsoft: 'none', teamsReady: false, appImportCovered: true }),
            ],
        })));
        renderWithClient(<TeamsMembersOverview />);
        await screen.findByText('Member Four');
        for (const id of ['u1', 'u4']) {
            const cells = rowOf(id).querySelectorAll('td');
            expect(cells[3].textContent).toBe(text);
        }
    });

    it('never renders a field the row type does not have', async () => {
        fetchMock.mockResolvedValue(answer(overview()));
        const { container } = renderWithClient(<TeamsMembersOverview />);
        await screen.findByText('Member Three');
        const html = container.innerHTML;
        for (const leaked of ['member@fixture.test', 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', 'fixture-scope-string']) {
            expect(html).not.toContain(leaked);
        }
    });

    it('asks again for another window', async () => {
        fetchMock.mockResolvedValue(answer(overview()));
        const user = userEvent.setup();
        renderWithClient(<TeamsMembersOverview />);
        await screen.findByText('Member One');
        expect(String(fetchMock.mock.calls[0][0])).toMatch(/\/api\/teams-setup\/org\/overview\?days=7$/);
        await user.selectOptions(screen.getByRole('combobox'), '30');
        await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
        expect(String(fetchMock.mock.calls[1][0])).toMatch(/days=30$/);
        expect(screen.getByRole('option', { name: 'Last 14 days' })).toBeTruthy();
    });

    it('says when the list is cut short, and when there are no members', async () => {
        fetchMock.mockResolvedValue(answer(overview({ truncated: true })));
        const { unmount } = renderWithClient(<TeamsMembersOverview />);
        expect(await screen.findByText('Only the first 3 members are shown.')).toBeTruthy();
        unmount();
        fetchMock.mockResolvedValue(answer(overview({ members: [], totals: { members: 0, connected: 0, missingPermissions: 0, needsReauth: 0, skipped: 0, failedImports: 0 } })));
        renderWithClient(<TeamsMembersOverview />);
        expect(await screen.findByText('No members yet.')).toBeTruthy();
    });

    it('a failed load says so', async () => {
        fetchMock.mockResolvedValue(answer({ error: 'Only organisation admins can do this' }, 403));
        renderWithClient(<TeamsMembersOverview />);
        expect((await screen.findByRole('alert')).textContent).toBe('The member overview could not be loaded.');
    });
});
