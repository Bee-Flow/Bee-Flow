/**
 * The organisation index: its themed groups, the rows that carry a value
 * (the website, the licence tier), the member's card and the search field
 * that reaches the screens below a section.
 */

import { fireEvent, screen } from '@testing-library/react-native';
import React from 'react';

import { buildAccessSnapshot, useAccess } from '@/core/access';
import { useLicenseStatus } from '@/features/usage';
import { openRoute } from '@/shared/navigation';
import { renderWithProviders } from '@/shared/testing/renderWithProviders';

import { OrgScreen } from './OrgScreen';
import { useLicenseHealth } from '../hooks/queries';
import { useOrgSections } from '../hooks/useOrgSections';
import { visibleOrgSections, type OrgVisibilityInputs } from '../model/visibility';

jest.mock('../hooks/useOrgSections', () => ({ useOrgSections: jest.fn() }));
jest.mock('../hooks/queries', () => ({ useLicenseHealth: jest.fn() }));
jest.mock('@/features/usage', () => ({ ...jest.requireActual('@/features/usage'), useLicenseStatus: jest.fn() }));
jest.mock('@/core/access', () => ({ ...jest.requireActual('@/core/access'), useAccess: jest.fn() }));
jest.mock('@/shared/navigation', () => ({ ...jest.requireActual('@/shared/navigation'), openRoute: jest.fn() }));
const mockUser = { id: 'me', organizationId: 'o1', orgRole: 'org_admin', organization: { name: 'Acme' } };
jest.mock('@/core/auth/AuthProvider', () => ({ useAuth: () => ({ user: mockUser }) }));
const mockPush = jest.fn();
jest.mock('expo-router', () => ({
    Stack: { Screen: () => null },
    useRouter: () => ({ back: jest.fn(), canGoBack: () => true, push: mockPush, replace: jest.fn() }),
}));

const ADMIN: OrgVisibilityInputs = {
    canSeeOrg: true,
    canManageUsers: true,
    canSeeCompliance: true,
    canUseLearning: true,
    isSuperAdmin: false,
    isSelfHosted: false,
    isNcOrg: false,
    isNcConnectorUser: false,
    authLocked: false,
    githubConnected: false,
};
const query = (data: unknown) => ({ data, isRefetching: false, refetch: jest.fn() });
const snapshot = (orgRole: string) =>
    buildAccessSnapshot({
        user: { id: 'me', displayName: 'Ada', isAdmin: false, role: 'user', provider: 'local', orgRole },
        permissions: { permissions: [], groups: [], organizations: [], allowedAgentTypes: [] },
    });
const HEALTHY = { refresher: { enabled: true }, crl: { enabled: true }, dunning: { past_due_count: 0, suspended_count: 0 }, now: '' };
const LICENCE = { tier: 'business', source: 'license_key', license: { expiresAt: '2099-01-01', refreshStatus: 'ok' }, features: [], limits: {} };

function arrange({ admin = true, inputs = ADMIN, health = HEALTHY }: { admin?: boolean; inputs?: OrgVisibilityInputs; health?: object } = {}) {
    (useAccess as jest.Mock).mockReturnValue(snapshot(admin ? 'org_admin' : 'member'));
    (useOrgSections as jest.Mock).mockReturnValue({
        sections: visibleOrgSections(admin ? inputs : { ...inputs, canSeeOrg: false, canManageUsers: false, canSeeCompliance: false }),
        org: { ...query(admin ? { id: 'o1', name: 'Acme', website: 'acme.nl' } : null) },
        refetch: jest.fn(),
    });
    (useLicenseStatus as jest.Mock).mockReturnValue(query(LICENCE));
    (useLicenseHealth as jest.Mock).mockReturnValue(query(admin ? health : undefined));
}

beforeEach(() => jest.clearAllMocks());

describe('OrgScreen', () => {
    it('files an admin’s sections in themed groups, the website and tier as row values', async () => {
        arrange();
        await renderWithProviders(<OrgScreen />);
        // Group titles are drawn in capitals.
        for (const title of ['ORGANISATION', 'PEOPLE & ACCESS', 'PRIVACY & SECURITY', 'AI & DATA', 'INTEGRATIONS', 'MONITORING']) {
            expect(screen.getByText(title)).toBeTruthy();
        }
        expect(screen.getByText('acme.nl')).toBeTruthy();
        expect(screen.getByText('Business')).toBeTruthy();
        expect(screen.queryByTestId('org-section-access')).toBeNull();
        expect(screen.queryByText('Identifier')).toBeNull();
        expect(screen.queryByText('Refresher')).toBeNull();
    });

    it('shows the whole licence group when the health reports a problem', async () => {
        arrange({ health: { ...HEALTHY, dunning: { past_due_count: 2, suspended_count: 0 } } });
        await renderWithProviders(<OrgScreen />);
        expect(screen.getByText('Accounts past due')).toBeTruthy();
    });

    it('shows the whole licence group on self-hosted, where there is no licence row', async () => {
        arrange({ inputs: { ...ADMIN, isSelfHosted: true } });
        await renderWithProviders(<OrgScreen />);
        expect(screen.queryByTestId('org-section-license')).toBeNull();
        expect(screen.getByText('Refresher')).toBeTruthy();
    });

    it('gives a member the name, the tier and their own privacy, without a search', async () => {
        arrange({ admin: false });
        await renderWithProviders(<OrgScreen />);
        expect(screen.getByText('Licence tier')).toBeTruthy();
        expect(screen.getByText('Your privacy settings')).toBeTruthy();
        expect(screen.queryByText('Refresher')).toBeNull();
        expect(screen.queryByPlaceholderText('Find an organisation setting')).toBeNull();
    });

    it('searches every organisation screen, the deeper ones included', async () => {
        arrange();
        await renderWithProviders(<OrgScreen />);
        await fireEvent.changeText(screen.getByPlaceholderText('Find an organisation setting'), 'invitations');
        expect(screen.queryByText('PEOPLE & ACCESS')).toBeNull();
        await fireEvent.press(screen.getByTestId('org-place-org-invitations'));
        expect(openRoute).toHaveBeenCalledWith(expect.anything(), '/org/invitations');
        await fireEvent.changeText(screen.getByPlaceholderText('Find an organisation setting'), 'zzzz');
        expect(screen.getByText('No results found')).toBeTruthy();
    });
});
