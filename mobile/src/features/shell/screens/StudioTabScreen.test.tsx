/**
 * The Studio tab against canned answers: the Workspace group that took over
 * the drawer's Cowork, Apps, Forms and Notebooks rows (and the Cowork tab),
 * for a member and for a builder, each row opening its own screen.
 */

import { fireEvent, screen } from '@testing-library/react-native';
import React from 'react';

import { api } from '@/core/api/client';
import { useAuth } from '@/core/auth/AuthProvider';
import type { PermissionsResponse, User } from '@/core/auth/types';
import { renderWithProviders } from '@/shared/testing/renderWithProviders';

import { StudioTabScreen } from './StudioTabScreen';

jest.setTimeout(30_000);

const mockRouter = { push: jest.fn(), navigate: jest.fn(), dismissTo: jest.fn(), canDismiss: () => false, back: jest.fn() };
jest.mock('expo-router', () => ({ useRouter: () => mockRouter }));
jest.mock('expo-web-browser', () => ({ openBrowserAsync: jest.fn() }));
jest.mock('@/core/auth/AuthProvider', () => ({ useAuth: jest.fn() }));
jest.mock('@/core/api/client', () => jest.requireActual('@/shared/testing/screenMocks').apiClient());
jest.mock('@/core/access/api', () => ({
    fetchEntitlements: jest.fn(async () => ({
        mode: 'cloud',
        tier: 'enterprise',
        superAdmin: false,
        degraded: false,
        ceiling: { core: ['automations', 'app_studio', 'notebooks'], beta: [], integration: [] },
        effective: { core: ['automations', 'app_studio', 'notebooks'], beta: [], integration: [] },
        reasons: {},
        registry: [],
    })),
    fetchLicenseInfo: jest.fn(async () => ({ tier: 'enterprise', source: 'license_key', features: [], serverOverride: false })),
}));

const ANSWERS: Record<string, unknown> = {
    '/api/cowork': [
        { id: 's1', title: 'Digest', isActive: true },
        { id: 's2', title: 'Quiet', isActive: true },
        { id: 's3', title: 'Off', isActive: false },
    ],
    '/api/studio-apps': {
        apps: [
            { id: 'ap', name: 'Expenses', icon: '📊', description: 'Claim what you spent', isPublished: true },
            { id: 'dr', name: 'Draft', icon: '', description: '', isPublished: false },
        ],
    },
    '/api/studio/counts': { counts: { automations: 4, forms: 2 }, makers: 2 },
    '/api/studio/attention': { rows: [], total: 0, unavailable: [], capped: [], gated: [], complete: true },
};

const ADA: User = { id: 'u1', displayName: 'Ada', isAdmin: false, role: 'user', provider: 'local' };

function signIn(user: Partial<User>, permissions: string[]) {
    const full = { ...ADA, ...user };
    const perms: PermissionsResponse = {
        permissions,
        groups: [],
        organizations: [],
        allowedAgentTypes: [],
        canUseFeature: { automations: true, app_studio: true },
    };
    (useAuth as jest.Mock).mockReturnValue({ stage: { kind: 'signed-in', user: full }, user: full, permissions: perms });
}

beforeEach(() => {
    jest.clearAllMocks();
    (api.get as jest.Mock).mockImplementation((path: string) => Promise.resolve(ANSWERS[path] ?? null));
});

describe('StudioTabScreen', () => {
    it('gives a member the Workspace group, and none of the builder’s Studio', async () => {
        signIn({ orgRole: 'member' }, ['use_apps', 'use_forms', 'use_notebooks']);
        await renderWithProviders(<StudioTabScreen />);
        expect(await screen.findByText('Workspace')).toBeTruthy();
        expect(await screen.findByLabelText('Cowork, 2')).toBeTruthy();
        expect(await screen.findByLabelText('Apps, 1')).toBeTruthy();
        expect(screen.getByTestId('studio-link-forms')).toBeTruthy();
        expect(screen.getByTestId('studio-link-notebooks')).toBeTruthy();
        expect(screen.queryByTestId('studio-new')).toBeNull();
        expect(screen.queryByText('Build')).toBeNull();
        expect(api.get).not.toHaveBeenCalledWith('/api/studio/counts', expect.anything());
    });

    it('opens each Workspace row on its own screen, pushed over the tabs', async () => {
        signIn({ orgRole: 'member' }, ['use_apps', 'use_forms', 'use_notebooks']);
        await renderWithProviders(<StudioTabScreen />);
        await fireEvent.press(await screen.findByTestId('studio-link-cowork'));
        expect(mockRouter.push).toHaveBeenCalledWith('/cowork');
        await fireEvent.press(await screen.findByTestId('studio-link-apps'));
        expect(mockRouter.push).toHaveBeenCalledWith('/apps');
        await fireEvent.press(screen.getByTestId('studio-link-forms'));
        expect(mockRouter.push).toHaveBeenCalledWith('/forms');
        await fireEvent.press(screen.getByTestId('studio-link-notebooks'));
        expect(mockRouter.push).toHaveBeenCalledWith('/notebooks');
    });

    it('offers only Cowork to someone with none of the others', async () => {
        signIn({ orgRole: 'member' }, []);
        await renderWithProviders(<StudioTabScreen />);
        expect(await screen.findByLabelText('Cowork, 2')).toBeTruthy();
        for (const id of ['apps', 'forms', 'notebooks']) expect(screen.queryByTestId(`studio-link-${id}`)).toBeNull();
    });

    it('gives a builder the Workspace above the sections, with Forms under Build rather than twice', async () => {
        signIn({ orgRole: 'org_admin' }, ['manage_agents', 'use_automations', 'use_forms', 'use_notebooks']);
        await renderWithProviders(<StudioTabScreen />);
        expect(await screen.findByLabelText('Automations, 4')).toBeTruthy();
        expect(screen.getByText('Workspace')).toBeTruthy();
        expect(screen.getByTestId('studio-link-cowork')).toBeTruthy();
        expect(screen.getByTestId('studio-link-notebooks')).toBeTruthy();
        // Studio's own Forms section (under Build, further down the list) lists them.
        expect(screen.queryByTestId('studio-link-forms')).toBeNull();
        expect(screen.getByTestId('studio-new')).toBeTruthy();
    });
});
