/**
 * Organisation Info, the organisation theme and the Academy overview against
 * canned answers: the partial patches their saves send, the logo and language
 * actions that apply at once, the theme repaint, and the Academy's gate.
 */

import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import * as ImagePicker from 'expo-image-picker';
import React from 'react';

import { useGate } from '@/core/access';
import { api } from '@/core/api/client';
import { ConfirmProvider } from '@/shared/patterns';
import { renderWithProviders, testQueryClient } from '@/shared/testing/renderWithProviders';
import { ToastProvider } from '@/shared/ui';

import { OrgAcademyScreen } from './OrgAcademyScreen';
import { OrgInfoScreen } from './OrgInfoScreen';
import { OrgThemeScreen } from './OrgThemeScreen';
import { uploadOrgLogo } from '../api/profile';
import { useOrgContext } from '../hooks/useOrgSections';

jest.setTimeout(30_000);

jest.mock('../hooks/useOrgSections', () => ({ useOrgContext: jest.fn() }));
jest.mock('@/core/access', () => ({ ...jest.requireActual('@/core/access'), useGate: jest.fn() }));
const mockUser: { id: string; organizationId: string; ncOrg?: object } = { id: 'me', organizationId: 'o1' };
// The drawer reads the org's name and logo from the signed-in user: a change re-reads it.
const mockRefresh = jest.fn(async () => undefined);
jest.mock('@/core/auth/AuthProvider', () => ({ useAuth: () => ({ user: mockUser, refresh: mockRefresh }) }));
jest.mock('../api/profile', () => ({ ...jest.requireActual('../api/profile'), uploadOrgLogo: jest.fn() }));
jest.mock('@/core/api/server', () => ({
    ...jest.requireActual('@/core/api/server'),
    apiUrl: (path: string) => `https://bee.test${path}`,
}));
// No media-library permission on purpose: the Photo Picker needs none (src/meta/photoPicker.test.ts).
jest.mock('expo-image-picker', () => ({
    launchImageLibraryAsync: jest.fn(),
}));
jest.mock('@/core/api/client', () => {
    const actual = jest.requireActual('@/core/api/client');
    return { ...actual, api: { delete: jest.fn(), get: jest.fn(), patch: jest.fn(), post: jest.fn(), put: jest.fn() } };
});
jest.mock('expo-router', () => ({
    Stack: { Screen: () => null },
    useRouter: () => ({ back: jest.fn(), canGoBack: () => true, push: jest.fn(), replace: jest.fn() }),
    useNavigation: () => ({ isFocused: () => true, addListener: () => () => undefined, dispatch: jest.fn() }),
}));

const ORG = { id: 'o1', name: 'Acme', city: 'x', billingCity: 'Delft', logo: '/uploads/org-logo.png' };
const SERVER: Record<string, unknown> = {
    '/auth/organizations/o1': ORG,
    '/api/languages/org/default': {
        defaultLocale: 'en',
        locales: [
            { code: 'en', name: 'English' },
            { code: 'nl', name: 'Nederlands' },
        ],
    },
    '/api/branding/admin': { preset: 'light', accent: '#9ca3af', radiusScale: 1, font: 'system', allowUserOverride: true, glassTint: 'warm' },
    '/api/icons': { packs: [{ id: 'p1', name: 'Line icons', icons: { 'tools.search': {} } }], activeIconPackId: null },
    '/ai/learning/org-overview': {
        courses: [
            { id: 'c1', title: 'Basics', lessonCount: 3 },
            { id: 'c2', title: 'Agents', lessonCount: 5 },
        ],
        totals: { members: 2, coursesCompleted: 3, certificatesIssued: 1, activeLast30d: 1 },
        members: [
            { userId: 'u1', displayName: 'Ada Lovelace', email: 'ada@acme.nl', coursesDone: ['c1', 'c2'], badges: ['b'], certificates: [{ certificateId: 'x', level: 'Gold' }], lastActivity: new Date().toISOString() },
            { userId: 'u2', displayName: 'Bo Jansen', email: 'bo@acme.nl', coursesDone: [], badges: [], certificates: [], lastActivity: null },
        ],
    },
};

const mounted = (ui: React.ReactElement, queryClient = testQueryClient()) =>
    renderWithProviders(
        <ConfirmProvider>
            <ToastProvider>{ui}</ToastProvider>
        </ConfirmProvider>,
        { queryClient },
    );

beforeEach(() => {
    jest.clearAllMocks();
    (useOrgContext as jest.Mock).mockReturnValue({ orgId: 'o1', isNcOrg: false, isOrgAdmin: true, isSelfHosted: false });
    (useGate as jest.Mock).mockReturnValue({ visible: true, locked: false, reason: null });
    (api.get as jest.Mock).mockImplementation(async (path: string) => SERVER[path] ?? null);
    (api.put as jest.Mock).mockImplementation(async (path: string, body: object) =>
        path === '/api/branding/admin' ? { ...(SERVER[path] as object), ...body } : { success: true },
    );
    (api.post as jest.Mock).mockResolvedValue({ success: true });
    (api.delete as jest.Mock).mockResolvedValue({ success: true });
});

describe('OrgInfoScreen', () => {
    it('saves only the fields that changed, the country from the web list', async () => {
        await mounted(<OrgInfoScreen />);
        const name = await screen.findByTestId('org-field-name');
        await fireEvent.changeText(name, 'Acme B.V.');
        await fireEvent.press(screen.getByTestId('org-field-billingCountry'));
        await fireEvent.changeText(screen.getByPlaceholderText('Search countries'), 'nether');
        await fireEvent.press(screen.getByText('Netherlands'));
        await fireEvent.press(screen.getByText('Save'));
        await waitFor(() =>
            expect(api.put).toHaveBeenCalledWith('/auth/organizations/o1', { name: 'Acme B.V.', billingCountry: 'NL' }),
        );
        await waitFor(() => expect(mockRefresh).toHaveBeenCalledTimes(1));
    });

    it('refuses an empty name before it is sent', async () => {
        await mounted(<OrgInfoScreen />);
        await fireEvent.changeText(await screen.findByTestId('org-field-name'), '  ');
        expect(screen.getAllByText('An organisation needs a name.').length).toBeGreaterThan(0);
        await fireEvent.press(screen.getByText('Save'));
        expect(api.put).not.toHaveBeenCalled();
    });

    it('sets the default language at once', async () => {
        await mounted(<OrgInfoScreen />);
        await fireEvent.press(await screen.findByTestId('locale-nl'));
        await waitFor(() => expect(api.put).toHaveBeenCalledWith('/api/languages/org/default', { defaultLocale: 'nl' }));
    });

    it('uploads a picked logo and removes it after a confirm', async () => {
        (ImagePicker.launchImageLibraryAsync as jest.Mock).mockResolvedValue({
            canceled: false,
            assets: [{ uri: 'file:///logo.png', mimeType: 'image/png', fileName: 'logo.png', fileSize: 1000 }],
        });
        (uploadOrgLogo as jest.Mock).mockResolvedValue({ logo: '/uploads/new.png' });
        await mounted(<OrgInfoScreen />);
        expect(await screen.findByTestId('org-logo')).toBeTruthy();
        await fireEvent.press(screen.getByText('Upload Logo'));
        await waitFor(() =>
            expect(uploadOrgLogo).toHaveBeenCalledWith('o1', { uri: 'file:///logo.png', name: 'logo.png', mimeType: 'image/png' }),
        );
        await waitFor(() => expect(mockRefresh).toHaveBeenCalledTimes(1));
        await fireEvent.press(screen.getByText('Remove logo'));
        const [, confirmButton] = screen.getAllByLabelText('Remove logo');
        await fireEvent.press(confirmButton as NonNullable<typeof confirmButton>);
        await waitFor(() => expect(api.delete).toHaveBeenCalledWith('/auth/organizations/o1/logo'));
        await waitFor(() => expect(mockRefresh).toHaveBeenCalledTimes(2));
    });

    it('refuses a logo too large for the server without uploading it', async () => {
        (ImagePicker.launchImageLibraryAsync as jest.Mock).mockResolvedValue({
            canceled: false,
            assets: [{ uri: 'file:///big.png', mimeType: 'image/png', fileSize: 5 * 1024 * 1024 }],
        });
        await mounted(<OrgInfoScreen />);
        await fireEvent.press(await screen.findByText('Upload Logo'));
        expect(await screen.findByText('A logo is at most 2 MB.')).toBeTruthy();
        expect(uploadOrgLogo).not.toHaveBeenCalled();
    });
});

describe('OrgInfoScreen for a Nextcloud organisation', () => {
    afterEach(() => {
        delete mockUser.ncOrg;
    });

    it('shows which Nextcloud instance owns it', async () => {
        mockUser.ncOrg = { instanceId: 'nc1', baseUrl: 'https://cloud.acme.nl', syncMode: 'mirror_all', lastSyncAt: null };
        (useOrgContext as jest.Mock).mockReturnValue({ orgId: 'o1', isNcOrg: true, isOrgAdmin: true, isSelfHosted: false });
        await mounted(<OrgInfoScreen />);
        expect(await screen.findByText('https://cloud.acme.nl')).toBeTruthy();
        expect(screen.getByText('mirror all')).toBeTruthy();
    });
});

describe('OrgThemeScreen', () => {
    it('sends only the changed knobs and repaints the app', async () => {
        const queryClient = testQueryClient();
        const invalidate = jest.spyOn(queryClient, 'invalidateQueries');
        await mounted(<OrgThemeScreen />, queryClient);
        await fireEvent.press(await screen.findByTestId('choice-dark'));
        await fireEvent.press(screen.getByTestId('accent-#3b82f6'));
        await fireEvent.press(screen.getByLabelText('More'));
        expect(screen.getByText('1.05×')).toBeTruthy();
        await fireEvent.press(screen.getByText('Save'));
        await waitFor(() =>
            expect(api.put).toHaveBeenCalledWith('/api/branding/admin', { preset: 'dark', accent: '#3b82f6', radiusScale: 1.05 }),
        );
        await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: ['settings', 'branding'] }));
    });

    it('takes a typed hex colour only when the server would accept it', async () => {
        await mounted(<OrgThemeScreen />);
        const hex = await screen.findByTestId('accent-hex');
        await fireEvent.changeText(hex, '#12345');
        expect(screen.getByText('A colour like #3b82f6: a # and six hex digits.')).toBeTruthy();
        expect(screen.queryByTestId('save-bar')).toBeNull();
        await fireEvent.changeText(hex, '10B981');
        await fireEvent.press(screen.getByText('Save'));
        await waitFor(() => expect(api.put).toHaveBeenCalledWith('/api/branding/admin', { accent: '#10b981' }));
    });

    it('switches the icon pack', async () => {
        await mounted(<OrgThemeScreen />);
        await fireEvent.press(await screen.findByTestId('icon-pack-row'));
        expect(screen.getByText('1 custom icons')).toBeTruthy();
        await fireEvent.press(screen.getByTestId('icon-pack-p1'));
        await waitFor(() => expect(api.post).toHaveBeenCalledWith('/api/icons/p1/activate'));
    });
});

describe('OrgAcademyScreen', () => {
    it('shows the totals and every member, searchable and filterable by course', async () => {
        await mounted(<OrgAcademyScreen />);
        expect(await screen.findByText('Ada Lovelace')).toBeTruthy();
        expect(screen.getByText('Bo Jansen')).toBeTruthy();
        expect(screen.getByText('Courses 2/2 · Badges 1 · Certificates Gold')).toBeTruthy();
        expect(screen.getByText('Not started')).toBeTruthy();
        await fireEvent.press(screen.getByTestId('academy-course-c2'));
        expect(screen.queryByText('Bo Jansen')).toBeNull();
    });

    it('shows the licence lock instead of asking, and waits while entitlements load', async () => {
        (useGate as jest.Mock).mockReturnValue({ visible: true, locked: true, reason: 'upgrade' });
        await mounted(<OrgAcademyScreen />);
        expect(screen.getByText('Available on a higher plan')).toBeTruthy();
        (useGate as jest.Mock).mockReturnValue({ visible: false, locked: false, reason: 'pending' });
        await mounted(<OrgAcademyScreen />);
        expect(api.get).not.toHaveBeenCalled();
    });
});
