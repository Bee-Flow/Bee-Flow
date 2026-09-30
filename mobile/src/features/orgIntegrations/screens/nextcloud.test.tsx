/**
 * Nextcloud Sync, pairing codes and the two meeting-notes settings screens
 * against canned server answers — above all, that a replace-on-save sends
 * the whole document back, "no opinion" and legacy lists included.
 */

import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import React from 'react';

import { api } from '@/core/api/client';
import { renderScreen } from '@/shared/testing/renderWithProviders';

import { MeetNotesScreen } from './MeetNotesScreen';
import { NcPairingScreen } from './NcPairingScreen';
import { NextcloudScreen } from './NextcloudScreen';
import { TalkNotesScreen } from './TalkNotesScreen';

jest.setTimeout(30_000);

const mockRouter = { push: jest.fn(), replace: jest.fn(), back: jest.fn() };
const mockOrg = { orgId: 'o1', isOrgAdmin: true, isSelfHosted: false, isNcOrg: true };
const mockAccess = { isSuperAdmin: false, orgRole: 'org_admin' };
let mockLicensed = true;

jest.mock('expo-router', () => ({
    useRouter: () => mockRouter,
    useNavigation: () => ({ addListener: () => () => undefined, dispatch: jest.fn() }),
    Stack: { Screen: () => null },
}));
jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn(async () => true) }));
jest.mock('@/core/api/client', () => jest.requireActual('@/shared/testing/screenMocks').apiClient());
jest.mock('@/core/auth/AuthProvider', () => ({ useAuth: () => ({ user: { id: 'me', organizationId: 'o1' } }) }));
jest.mock('@/features/org', () => ({ ...jest.requireActual('@/features/org'), useOrgContext: () => mockOrg }));
jest.mock('@/core/access', () => ({
    ...jest.requireActual('@/core/access'),
    useAccess: () => mockAccess,
    holds: () => true,
    hasLicenseFeature: () => mockLicensed,
}));

let answers: Record<string, unknown> = {};

beforeEach(() => {
    jest.clearAllMocks();
    Object.assign(mockOrg, { orgId: 'o1', isOrgAdmin: true, isSelfHosted: false, isNcOrg: true });
    mockLicensed = true;
    answers = {};
    (api.get as jest.Mock).mockImplementation((path: string) => Promise.resolve(answers[path] ?? null));
    (api.post as jest.Mock).mockResolvedValue({ ok: true });
    (api.put as jest.Mock).mockResolvedValue({ ok: true });
    (api.delete as jest.Mock).mockResolvedValue({ ok: true });
});

describe('NextcloudScreen', () => {
    beforeEach(() => {
        answers = {
            '/auth/admin/o1/nc-sync': { ncBaseUrl: 'https://cloud.acme.nl', mode: 'mirror_all', syncGroups: [], excludedGroups: [], newUserDefaultStatus: 'active' },
            '/auth/admin/o1/nc-sync/groups': { groups: ['Sales', 'Ops'] },
            '/auth/admin/o1/nc-sync/users': { users: [{ id: 'u1', displayName: 'An', status: 'active' }] },
        };
    });

    it('shows the binding and runs a sync, reporting the server’s counts', async () => {
        (api.post as jest.Mock).mockResolvedValue({ created: 2, deactivated: 1 });
        await renderScreen(<NextcloudScreen />);
        expect(await screen.findByText('cloud.acme.nl')).toBeTruthy();
        await fireEvent.press(screen.getByTestId('nc-sync-now'));
        await waitFor(() => expect(api.post).toHaveBeenCalledWith('/auth/admin/o1/nc-sync/run'));
        expect(await screen.findByText('Sync done: created 2, deactivated 1')).toBeTruthy();
    });

    it('links the pairing and meeting-notes pages', async () => {
        await renderScreen(<NextcloudScreen />);
        await fireEvent.press(await screen.findByTestId('nc-talk'));
        expect(mockRouter.push).toHaveBeenCalledWith('/org/nextcloud/talk');
        await fireEvent.press(screen.getByTestId('nc-pairing'));
        expect(mockRouter.push).toHaveBeenCalledWith('/org/nextcloud/pairing');
    });

    it('says why there is nothing to sync for an org without a Nextcloud', async () => {
        mockOrg.isNcOrg = false;
        await renderScreen(<NextcloudScreen />);
        expect(screen.getByText(/only available for organisations bound to a Nextcloud/)).toBeTruthy();
        expect(api.get).not.toHaveBeenCalledWith('/auth/admin/o1/nc-sync', expect.anything());
    });
});

describe('NcPairingScreen', () => {
    it('generates a code with an empty body, and revokes one after asking', async () => {
        answers['/auth/admin/nc-bindings/pairing-codes'] = { codes: [{ id: 'c1', code: 'ABCD-1234', expiresAt: new Date(Date.now() + 600_000).toISOString() }] };
        await renderScreen(<NcPairingScreen />);
        expect(await screen.findByText('ABCD-1234')).toBeTruthy();
        await fireEvent.press(screen.getByTestId('pairing-generate'));
        await waitFor(() => expect(api.post).toHaveBeenCalledWith('/auth/admin/nc-bindings/generate-pairing-code', {}));
        await fireEvent.press(screen.getByLabelText('Revoke'));
        expect(api.delete).not.toHaveBeenCalled();
        const confirm = screen.getAllByLabelText('Revoke').at(-1);
        await fireEvent.press(confirm as NonNullable<typeof confirm>);
        await waitFor(() => expect(api.delete).toHaveBeenCalledWith('/auth/admin/nc-bindings/pairing-codes/c1'));
    });
});

describe('TalkNotesScreen', () => {
    it('sends the whole document back, keeping "no opinion" and the legacy lists', async () => {
        answers['/api/talk-notes-settings/o1'] = {
            autoTranscribe: null,
            postSummaryBack: true,
            recordingFolder: null,
            language: 'nl',
            autoRecord: null,
            autoRecordScope: null,
            recordingMode: null,
            insightsPerPersonStats: true,
            defaultOwnerUserId: 'u9',
            excludedEventUids: ['legacy'],
            excludedRoomTokens: [],
        };
        await renderScreen(<TalkNotesScreen />);
        await fireEvent(await screen.findByTestId('talk-auto-transcribe'), 'valueChange', true);
        await fireEvent.press(screen.getByText('Save'));
        await waitFor(() =>
            expect(api.put).toHaveBeenCalledWith('/api/talk-notes-settings/o1', {
                autoTranscribe: true,
                postSummaryBack: true,
                recordingFolder: null,
                language: 'nl',
                autoRecord: null,
                autoRecordScope: null,
                recordingMode: null,
                insightsPerPersonStats: true,
                defaultOwnerUserId: 'u9',
                excludedEventUids: ['legacy'],
                excludedRoomTokens: [],
            }),
        );
    });

    it('turns an admin without the Meeting Notes licence away', async () => {
        mockLicensed = false;
        await renderScreen(<TalkNotesScreen />);
        expect(api.get).not.toHaveBeenCalled();
    });
});

describe('MeetNotesScreen', () => {
    it('sends back only the keys the strict body accepts', async () => {
        answers['/api/gmeet-notes-settings/o1'] = { autoImport: null, autoRecordConfig: false, importScope: 'calendar', language: null, lookbackHours: 48, excludedEventIds: ['e1'] };
        await renderScreen(<MeetNotesScreen />);
        await fireEvent(await screen.findByTestId('meet-auto-import'), 'valueChange', true);
        await fireEvent.press(screen.getByText('Save'));
        await waitFor(() =>
            expect(api.put).toHaveBeenCalledWith('/api/gmeet-notes-settings/o1', {
                autoImport: true,
                autoRecordConfig: false,
                importScope: 'calendar',
                language: null,
                lookbackHours: 48,
                excludedEventIds: ['e1'],
                excludedMeetingCodes: [],
            }),
        );
    });
});
