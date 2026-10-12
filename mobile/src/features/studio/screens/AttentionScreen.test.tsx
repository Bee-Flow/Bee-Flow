/**
 * "Needs attention", whole: every finding under its source's heading with the
 * group's size, each with its sentence, its remediation and "Show me", and the
 * lines that say what the list does not cover.
 */

import { fireEvent, screen } from '@testing-library/react-native';
import React from 'react';

import { api } from '@/core/api/client';
import { useAuth } from '@/core/auth/AuthProvider';
import type { User } from '@/core/auth/types';
import { renderWithProviders } from '@/shared/testing/renderWithProviders';

import { AttentionScreen } from './AttentionScreen';

jest.setTimeout(30_000);

const mockRouter = { push: jest.fn(), navigate: jest.fn(), dismissTo: jest.fn(), canDismiss: () => false, back: jest.fn() };
jest.mock('expo-router', () => ({ useRouter: () => mockRouter }));
jest.mock('@/core/auth/AuthProvider', () => ({ useAuth: jest.fn() }));
jest.mock('@/core/api/client', () => jest.requireActual('@/shared/testing/screenMocks').apiClient());
jest.mock('@/core/access/api', () => ({
    fetchEntitlements: jest.fn(async () => ({
        mode: 'cloud',
        tier: 'enterprise',
        superAdmin: false,
        degraded: false,
        ceiling: { core: ['automations', 'app_studio', 'skills'], beta: [], integration: [] },
        effective: { core: ['automations', 'skills'], beta: [], integration: [] },
        reasons: {},
        registry: [],
    })),
    fetchLicenseInfo: jest.fn(async () => ({ tier: 'enterprise', source: 'license_key', features: [], serverOverride: false })),
}));

const row = (id: string) => ({
    source: 'appValidation',
    code: 'binding.table_unverified',
    severity: 'warning',
    kind: 'app',
    targetId: id,
    message: `records binding references "${id}" — not verified until publish.`,
    remediation: 'Publishing checks it exists.',
    deepLink: `/app/studio/apps/${id}`,
});

const ATTENTION = {
    rows: [
        {
            source: 'automationFailing',
            code: 'automation_failing',
            severity: 'error',
            kind: 'automation',
            targetId: 'a1',
            message: 'Invoices failed three times in a row',
            deepLink: '/app/studio/automations/a1',
        },
        row('t1'),
        row('t2'),
    ],
    total: 5,
    unavailable: [],
    capped: [],
    gated: ['agentNoKb'],
    complete: true,
};

const ADA: User = { id: 'u1', displayName: 'Ada', isAdmin: false, role: 'user', provider: 'local', orgRole: 'org_admin' };

beforeEach(() => {
    jest.clearAllMocks();
    (useAuth as jest.Mock).mockReturnValue({
        stage: { kind: 'signed-in', user: ADA },
        user: ADA,
        permissions: {
            permissions: ['use_automations', 'manage_apps'],
            groups: [],
            organizations: [],
            allowedAgentTypes: [],
            canUseFeature: { automations: true, app_studio: true },
        },
    });
    (api.get as jest.Mock).mockImplementation((path: string) =>
        Promise.resolve(path === '/api/studio/attention' ? ATTENTION : { counts: {}, makers: null }),
    );
});

describe('AttentionScreen', () => {
    it('lists every finding under its source, with the group size', async () => {
        await renderWithProviders(<AttentionScreen />);
        expect(await screen.findByText('App has validation problems · 2')).toBeTruthy();
        expect(screen.getByText('Automation failed several times in a row')).toBeTruthy();
        expect(screen.getByText('Invoices failed three times in a row')).toBeTruthy();
        expect(screen.getByText('records binding references "t2" — not verified until publish.')).toBeTruthy();
        expect(screen.getAllByText('Publishing checks it exists.')).toHaveLength(2);
    });

    it('says what the list leaves out', async () => {
        await renderWithProviders(<AttentionScreen />);
        expect(await screen.findByText('2 more were found but are not shown here.')).toBeTruthy();
        expect(screen.getByText('Some checks only run for the people who can act on them.')).toBeTruthy();
    });

    it('tells someone without Studio that it is not for them, instead of spinning', async () => {
        const MEMBER: User = { ...ADA, orgRole: 'member' };
        (useAuth as jest.Mock).mockReturnValue({
            stage: { kind: 'signed-in', user: MEMBER },
            user: MEMBER,
            permissions: { permissions: ['use_automations'], groups: [], organizations: [], allowedAgentTypes: [], canUseFeature: {} },
        });
        await renderWithProviders(<AttentionScreen />);
        expect(await screen.findByText('Studio is not part of your account')).toBeTruthy();
        expect(api.get).not.toHaveBeenCalledWith('/api/studio/attention', expect.anything());
    });

    it('opens a finding on its object', async () => {
        await renderWithProviders(<AttentionScreen />);
        await fireEvent.press(await screen.findByTestId('studio-attention-row-automation_failing'));
        expect(mockRouter.push).toHaveBeenCalledWith('/automations/a1');
    });
});
