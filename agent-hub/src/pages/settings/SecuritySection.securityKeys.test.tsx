import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Settings → Security with security keys: an account may have an
 * authenticator app, security keys, or both. The card itself is stubbed (it
 * has SecurityKeysCard.test.tsx); what is pinned here is what the screen
 * around it does for each kind of account.
 *
 * No i18n mock, like SecuritySection.test.jsx: the strings asserted are the
 * ones a user reads.
 */

vi.mock('../../utils/helpers', () => ({ API_BASE: '', authFetch: vi.fn() }));
vi.mock('./TokenVaultSection', () => ({ default: () => null }));
vi.mock('../../components/mfa/SecurityKeysCard', () => ({
    default: (props: Record<string, unknown>) => (
        <div data-testid="security-keys-stub" data-mfa={String(props.mfaEnabled)} data-totp={String(props.totpEnabled)} />
    ),
}));
vi.mock('@simplewebauthn/browser', () => ({
    browserSupportsWebAuthn: vi.fn(() => true),
    startAuthentication: vi.fn(async () => ({ id: 'k', rawId: 'k', type: 'public-key', response: {} })),
    startRegistration: vi.fn(),
}));

import { authFetch } from '../../utils/helpers';
import SecuritySection from './SecuritySection';

const fetchMock = vi.mocked(authFetch);

const jsonRes = (body: unknown, status = 200) => ({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => 'application/json' },
    json: async () => body,
});

/** jsdom serves the page from localhost, so a key registered there works here. */
const KEY_ONLY = {
    enabled: true, totpEnabled: false, recoveryCodesRemaining: 8, hasPassword: true,
    securityKeys: 1, securityKeyRpIds: ['localhost'],
};
const WITH_APP_AND_KEY = { ...KEY_ONLY, totpEnabled: true };
const OFF = { enabled: false, recoveryCodesRemaining: 0, hasPassword: true, securityKeys: 0 };

function serve(status: unknown) {
    fetchMock.mockImplementation(async (url: string) => {
        const u = String(url);
        if (u.includes('/auth/mfa/status')) return jsonRes(status) as unknown as Response;
        if (u.includes('/auth/mfa/security-keys/proof/options')) return jsonRes({ options: { challenge: 'p' } }) as unknown as Response;
        if (u.includes('/auth/mfa/disable')) return jsonRes({ success: true }) as unknown as Response;
        if (u.includes('/auth/mfa/setup')) return jsonRes({ qr: 'data:image/png;base64,QQ==', secret: 'S', serverTime: Date.now() }) as unknown as Response;
        if (u.includes('/auth/mfa/enable')) return jsonRes({ recoveryCodes: ['aaaa-1111'] }) as unknown as Response;
        return jsonRes({}, 402) as unknown as Response;
    });
}

const bodyOf = (fragment: string) => {
    const call = fetchMock.mock.calls.find(([u]) => String(u).includes(fragment));
    return call ? JSON.parse(String((call[1] as RequestInit | undefined)?.body)) : undefined;
};

async function mount(status: unknown) {
    serve(status);
    render(<SecuritySection />);
    await screen.findByRole('heading', { name: 'Security' });
}

beforeEach(() => { fetchMock.mockReset(); });

describe('SecuritySection with security keys', () => {
    it('offers security keys with 2FA off too: a key can be the first factor', async () => {
        await mount(OFF);
        expect(screen.getByTestId('security-keys-stub')).toHaveAttribute('data-mfa', 'false');
    });

    it('tells the card an account is key-only', async () => {
        await mount(KEY_ONLY);
        const card = screen.getByTestId('security-keys-stub');
        expect(card).toHaveAttribute('data-mfa', 'true');
        expect(card).toHaveAttribute('data-totp', 'false');
    });

    it('offers to add an authenticator app to a key-only account, and only to that one', async () => {
        await mount(KEY_ONLY);
        expect(screen.getByRole('button', { name: 'Add authenticator app' })).toBeInTheDocument();
    });

    it('does not offer it when the account already has an app', async () => {
        await mount(WITH_APP_AND_KEY);
        expect(screen.queryByRole('button', { name: 'Add authenticator app' })).not.toBeInTheDocument();
    });

    it('asks a key-only account for a recovery code or a key, not an authenticator code', async () => {
        await mount(KEY_ONLY);
        await userEvent.click(screen.getByRole('button', { name: 'Disable' }));
        expect(screen.getByText('Enter a recovery code, or confirm with your security key')).toBeInTheDocument();
        expect(screen.getByPlaceholderText('a1b2-c3d4')).toBeInTheDocument();
    });

    it('turns 2FA off with a key tap as proof', async () => {
        await mount(KEY_ONLY);
        await userEvent.click(screen.getByRole('button', { name: 'Disable' }));
        await userEvent.click(screen.getByRole('button', { name: 'Confirm with security key' }));
        await waitFor(() => expect(bodyOf('/auth/mfa/disable')).toBeTruthy());
        expect(bodyOf('/auth/mfa/disable')).toEqual({ securityKey: { id: 'k', rawId: 'k', type: 'public-key', response: {} } });
    });

    it('adds an app to a key-only account with a key tap as proof', async () => {
        await mount(KEY_ONLY);
        await userEvent.click(screen.getByRole('button', { name: 'Add authenticator app' }));
        expect(await screen.findByText('After Enable, touch one of your security keys to confirm it is you.')).toBeInTheDocument();
        await userEvent.type(screen.getByPlaceholderText('000000'), '123456');
        await userEvent.click(screen.getByRole('button', { name: 'Enable' }));
        await waitFor(() => expect(bodyOf('/auth/mfa/enable')).toBeTruthy());
        expect(bodyOf('/auth/mfa/enable')).toEqual({
            code: '123456',
            proof: { securityKey: { id: 'k', rawId: 'k', type: 'public-key', response: {} } },
        });
    });

    it('warns that disabling removes the registered keys', async () => {
        await mount(WITH_APP_AND_KEY);
        await userEvent.click(screen.getByRole('button', { name: 'Disable' }));
        expect(screen.getByText('Turning two-factor authentication off also removes your security keys.')).toBeInTheDocument();
    });
});
