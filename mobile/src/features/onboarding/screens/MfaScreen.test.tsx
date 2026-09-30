/**
 * The second factor: an authenticator account opens on the six digits and can
 * switch to a recovery code; a security-key account (no 'totp' in `methods`)
 * opens on the recovery code, is told why, and is never offered an
 * authenticator it does not have. A server from before security keys sends no
 * `methods`, which means the app.
 */

import { screen } from '@testing-library/react-native';
import React from 'react';

import { renderWithProviders } from '@/shared/testing/renderWithProviders';

import { MfaScreen } from './MfaScreen';

const mockAuth = {
    stage: { kind: 'mfa-required', username: 'ada@example.nl' } as { kind: 'mfa-required'; username: string; methods?: string[] },
    submitMfaCode: jest.fn(),
    signOut: jest.fn(),
    clearError: jest.fn(),
    busy: false,
    error: null as string | null,
};
jest.mock('@/core/auth/AuthProvider', () => ({ useAuth: () => mockAuth }));

beforeEach(() => jest.clearAllMocks());

describe('MfaScreen', () => {
    it('opens on the authenticator when the server does not say (an older server)', async () => {
        mockAuth.stage = { kind: 'mfa-required', username: 'ada@example.nl' };
        await renderWithProviders(<MfaScreen />);
        expect(screen.getByText(/enter the six digits/)).toBeTruthy();
        expect(screen.getByText('Lost your authenticator? Use a recovery code')).toBeTruthy();
    });

    it('opens on the authenticator for an account that has one, next to a key', async () => {
        mockAuth.stage = { kind: 'mfa-required', username: 'ada@example.nl', methods: ['totp', 'security_key'] };
        await renderWithProviders(<MfaScreen />);
        expect(screen.getByText(/enter the six digits/)).toBeTruthy();
    });

    it('asks a security-key account for a recovery code, says why, and offers no authenticator', async () => {
        mockAuth.stage = { kind: 'mfa-required', username: 'ada@example.nl', methods: ['security_key'] };
        await renderWithProviders(<MfaScreen />);
        expect(screen.getByText(/signs in with a security key, which this app cannot use/)).toBeTruthy();
        expect(screen.queryByText('Use your authenticator app instead')).toBeNull();
        expect(screen.queryByText('Lost your authenticator? Use a recovery code')).toBeNull();
    });
});
