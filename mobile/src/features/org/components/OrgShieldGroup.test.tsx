import { fireEvent, screen } from '@testing-library/react-native';
import React from 'react';

import { renderWithProviders } from '@/shared/testing/renderWithProviders';

import { OrgShieldGroup } from './OrgShieldGroup';

const mockPush = jest.fn();
const mockAccess = { isOrgAdmin: true };

jest.mock('expo-router', () => ({ useRouter: () => ({ push: mockPush }) }));
jest.mock('@/core/auth/AuthProvider', () => ({ useAuth: () => ({ user: { id: 'me', organizationId: 'o1' } }) }));
jest.mock('@/core/access', () => ({
    ...jest.requireActual('@/core/access'),
    useAccess: () => ({ isOrgAdmin: mockAccess.isOrgAdmin, mode: 'cloud' }),
}));

const SHIELD = {
    enabled: true,
    collectionIds: [],
    scope: { userInput: true, agentOutput: true },
    action: 'delete',
    euModeEnabled: true,
    piiDetectionCategories: [],
    piiDetectionConfidenceThreshold: 0.7,
    piiDetectionAction: 'block',
    piiFailureMode: 'fail_closed',
    monitorIntegrations: false,
    applyToAutomations: true,
    piiAllowTerms: [],
    piiAllowPublicOrgs: true,
    clamped_fields: ['webSearchGuardEnabled'],
};

beforeEach(() => {
    mockPush.mockClear();
    mockAccess.isOrgAdmin = true;
});

it('offers an org admin the editor', async () => {
    await renderWithProviders(<OrgShieldGroup shield={SHIELD} />);
    expect(screen.getByText('Required')).toBeTruthy();
    expect(screen.getByText(/narrows webSearchGuardEnabled/)).toBeTruthy();
    await fireEvent.press(screen.getByTestId('edit-org-shield'));
    expect(mockPush).toHaveBeenCalledWith('/org/shield');
});

it('tells a member who sets it, without the edit row', async () => {
    mockAccess.isOrgAdmin = false;
    await renderWithProviders(<OrgShieldGroup shield={{ ...SHIELD, enabled: false }} />);
    expect(screen.getByText('Off')).toBeTruthy();
    expect(screen.getByText(/Set by your administrator/)).toBeTruthy();
    expect(screen.queryByTestId('edit-org-shield')).toBeNull();
});
