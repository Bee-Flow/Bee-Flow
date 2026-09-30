/** The foot of Usage: an org admin's way to the organisation's dashboard, and nothing for anyone else. */

import { fireEvent, screen } from '@testing-library/react-native';
import React from 'react';

import { renderWithProviders } from '@/shared/testing/renderWithProviders';

import { UsageFooter } from './UsageFooter';

jest.setTimeout(30_000);

const mockPush = jest.fn();
const mockState = { admin: true };

jest.mock('expo-router', () => ({ useRouter: () => ({ push: mockPush }) }));
jest.mock('@/core/access', () => ({ useIsOrgAdmin: () => mockState.admin }));

beforeEach(() => {
    mockPush.mockClear();
    mockState.admin = true;
});

describe('UsageFooter', () => {
    it('opens Usage & Monitoring for an org admin', async () => {
        await renderWithProviders(<UsageFooter />);
        await fireEvent.press(screen.getByTestId('usage-org-monitoring'));
        expect(mockPush).toHaveBeenCalledWith('/org/usage');
        expect(screen.getByText('Usage & Monitoring')).toBeTruthy();
    });

    it('shows nothing to a member', async () => {
        mockState.admin = false;
        await renderWithProviders(<UsageFooter />);
        expect(screen.queryByTestId('usage-org-monitoring')).toBeNull();
    });
});
