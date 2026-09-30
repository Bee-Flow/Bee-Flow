/**
 * The login screen against canned setup documents: providers merged from both
 * sources, the operator's password switch honoured only when it says no, what
 * was typed surviving a trip to the reset form and back — and the whole form
 * in the catalogue's language, which it did not speak before sign-in.
 */

import { act, fireEvent, screen } from '@testing-library/react-native';
import React from 'react';

import { api } from '@/core/api/client';
import { setCatalogue, _reset } from '@/core/i18n';
import { renderWithProviders } from '@/shared/testing/renderWithProviders';

import { LoginScreen } from './LoginScreen';

jest.setTimeout(30_000);

jest.mock('@/core/api/client', () => jest.requireActual('@/shared/testing/screenMocks').apiClient());
jest.mock('@/core/api/server', () => ({
    ...jest.requireActual('@/core/api/server'),
    getServerUrl: () => 'https://beeflow.example',
}));
const mockAuth = {
    stage: { kind: 'signed-out', oauthProviders: ['nextcloud'], isOAuthConfigured: true },
    signIn: jest.fn(),
    refresh: jest.fn(),
    forgetServer: jest.fn(),
    clearError: jest.fn(),
    busy: false,
    error: null as string | null,
};
jest.mock('@/core/auth/AuthProvider', () => ({ useAuth: () => mockAuth }));

function setupStatus(doc: Record<string, unknown>) {
    (api.get as jest.Mock).mockImplementation(async (path: string) => (path === '/auth/setup-status' ? doc : null));
}

beforeEach(() => jest.clearAllMocks());
afterEach(() => _reset());

describe('LoginScreen', () => {
    it('offers the providers from both sources, in the fixed order', async () => {
        setupStatus({ isGoogleConfigured: true, branding: { name: 'Acme', logo: null } });
        await renderWithProviders(<LoginScreen />);
        expect(await screen.findByText('Sign in to Acme')).toBeTruthy();
        expect(screen.getByText('Continue with Google')).toBeTruthy();
        expect(screen.getByText('Continue with Nextcloud')).toBeTruthy();
        expect(screen.getByText('OR')).toBeTruthy();
        expect(screen.getByText('beeflow.example')).toBeTruthy();
    });

    it('hides the password form only when the operator turned it off', async () => {
        setupStatus({ allowPasswordLogin: false });
        await renderWithProviders(<LoginScreen />);
        expect(await screen.findByText(/turned off password sign-in/)).toBeTruthy();
        expect(screen.queryByText('Email or username')).toBeNull();
        expect(screen.queryByText('OR')).toBeNull();
    });

    it('keeps what was typed across a trip to the reset form', async () => {
        setupStatus({});
        await renderWithProviders(<LoginScreen />);
        await fireEvent.changeText(await screen.findByLabelText('Email or username'), 'tom@acme.test');
        await fireEvent.press(screen.getByText('Forgot your password?'));
        expect(await screen.findByText('Reset your password')).toBeTruthy();
        await fireEvent.press(screen.getByText('Back to sign in'));
        expect(await screen.findByDisplayValue('tom@acme.test')).toBeTruthy();
    });

    it('signs in with the trimmed username', async () => {
        setupStatus({});
        await renderWithProviders(<LoginScreen />);
        await fireEvent.changeText(await screen.findByLabelText('Email or username'), '  tom ');
        await fireEvent.changeText(screen.getByLabelText('Password'), 'secret');
        // The title says "Sign in" too; the button is the one with the role.
        await fireEvent.press(screen.getByRole('button', { name: 'Sign in' }));
        expect(mockAuth.signIn).toHaveBeenCalledWith('tom', 'secret');
    });

    it('renders in the loaded catalogue’s language, and switches when it lands', async () => {
        setupStatus({ isGoogleConfigured: true, branding: { name: 'Acme', logo: null } });
        await renderWithProviders(<LoginScreen />);
        expect(await screen.findByText('Sign in to Acme')).toBeTruthy();

        // What the public catalogue installs before sign-in (settings' usePublicCatalogue).
        await act(async () => {
            setCatalogue('nl', {
                'login.password': 'Wachtwoord',
                'login.sign_in': 'Inloggen',
                'login.forgot_password': 'Wachtwoord vergeten?',
                'signup.continue_with_provider': 'Doorgaan met {provider}',
            });
        });
        expect(screen.getByLabelText('Wachtwoord')).toBeTruthy();
        expect(screen.getByRole('button', { name: 'Inloggen' })).toBeTruthy();
        expect(screen.getByText('Wachtwoord vergeten?')).toBeTruthy();
        expect(screen.getByText('Doorgaan met Google')).toBeTruthy();
        // A key the catalogue lacks keeps its English.
        expect(screen.getByText('Sign in to Acme')).toBeTruthy();
    });
});
