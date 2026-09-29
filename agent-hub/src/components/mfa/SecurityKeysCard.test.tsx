import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { withQueryClient } from '@/test/queryWrapper';

/**
 * Settings → Security: the security-keys card. The browser's WebAuthn calls
 * are stubbed (jsdom has no authenticator); the requests are real calls into
 * a mocked authFetch, so what is pinned is what the card sends and what it
 * shows back.
 *
 * jsdom serves the page from `localhost`, so a key registered under that RP
 * is "usable here" and one under any other host is not.
 */

vi.mock('../../hooks/useTranslation', () => import('@/test/useTranslationMock'));
vi.mock('../../utils/helpers', () => ({ API_BASE: '', authFetch: vi.fn() }));
vi.mock('@simplewebauthn/browser', () => ({
    browserSupportsWebAuthn: vi.fn(() => true),
    startRegistration: vi.fn(async () => ({ id: 'cred', rawId: 'cred', type: 'public-key', response: {} })),
    startAuthentication: vi.fn(async () => ({ id: 'old', rawId: 'old', type: 'public-key', response: {} })),
}));

import { authFetch } from '../../utils/helpers';
import { browserSupportsWebAuthn, startAuthentication, startRegistration } from '@simplewebauthn/browser';
import SecurityKeysCard from './SecurityKeysCard';

const fetchMock = vi.mocked(authFetch);

function json(body: unknown, status = 200) {
    return {
        ok: status >= 200 && status < 300,
        status,
        headers: { get: () => 'application/json' },
        json: async () => body,
        text: async () => JSON.stringify(body),
    } as unknown as Response;
}

/** 2FA on with an authenticator app: proof is a code by default. */
const WITH_APP = { mfaEnabled: true, totpEnabled: true };

const KEY_HERE = { id: 'k1', name: 'YubiKey 5C', rpId: 'localhost', createdAt: '2026-09-01T00:00:00Z', lastUsedAt: null };
const KEY_ELSEWHERE = { id: 'k2', name: 'Old laptop key', rpId: 'beeflow.nl', createdAt: '2026-08-01T00:00:00Z', lastUsedAt: '2026-09-02T00:00:00Z' };

/** Route the card's requests; `keys` is what the list endpoint answers now. */
function serve(state: { keys: unknown[] }, overrides: Record<string, () => Response> = {}) {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
        const u = String(url);
        const method = init?.method || 'GET';
        for (const [fragment, answer] of Object.entries(overrides)) if (u.includes(fragment)) return answer();
        if (u.endsWith('/auth/mfa/security-keys') && method === 'GET') return json({ keys: state.keys });
        if (u.endsWith('/proof/options')) return json({ options: { challenge: 'proof', rpId: 'localhost' } });
        if (u.endsWith('/registration/options')) return json({ options: { challenge: 'abc', rp: { id: 'localhost' } } });
        if (u.endsWith('/registration/verify')) { state.keys = [...state.keys, KEY_HERE]; return json({ key: KEY_HERE }); }
        if (method === 'DELETE') { state.keys = []; return json({ success: true }); }
        throw new Error(`unrouted: ${method} ${u}`);
    });
}

/** authFetch is plain JS, so its options argument types as `{}`. */
const initOf = (call: unknown[]) => call[1] as RequestInit | undefined;
const sent = (fragment: string) => fetchMock.mock.calls
    .filter(([u]) => String(u).includes(fragment))
    .map((call) => { const body = initOf(call)?.body; return body ? JSON.parse(String(body)) : undefined; });

afterEach(() => { fetchMock.mockReset(); vi.clearAllMocks(); vi.mocked(browserSupportsWebAuthn).mockReturnValue(true); });

describe('SecurityKeysCard', () => {
    it('lists the keys, and says which one does not work on this address', async () => {
        serve({ keys: [KEY_HERE, KEY_ELSEWHERE] });
        render(withQueryClient(<SecurityKeysCard {...WITH_APP} />));
        const rows = await screen.findAllByTestId('security-key-row');
        expect(rows).toHaveLength(2);
        expect(within(rows[0]).getByText('YubiKey 5C')).toBeInTheDocument();
        expect(within(rows[0]).queryByText(/does not work on this address/)).not.toBeInTheDocument();
        expect(within(rows[1]).getByText(/does not work on this address/)).toBeInTheDocument();
    });

    it('with an app, adds a key with a name and a code, then touches the key', async () => {
        const onChange = vi.fn();
        serve({ keys: [] });
        const user = userEvent.setup();
        render(withQueryClient(<SecurityKeysCard {...WITH_APP} onChange={onChange} />));
        expect(await screen.findByText('No security keys yet.')).toBeInTheDocument();

        await user.click(screen.getByRole('button', { name: /Add security key/ }));
        await user.type(screen.getByLabelText('Name'), 'YubiKey 5C');
        await user.type(screen.getByLabelText(/Code from your authenticator app/), '123456');
        await user.click(screen.getByRole('button', { name: 'Continue' }));

        expect(await screen.findByText('YubiKey 5C')).toBeInTheDocument();
        expect(sent('/registration/options')).toEqual([{ code: '123456', name: 'YubiKey 5C' }]);
        expect(vi.mocked(startRegistration)).toHaveBeenCalledWith({ optionsJSON: { challenge: 'abc', rp: { id: 'localhost' } } });
        expect(sent('/registration/verify')).toHaveLength(1);
        expect(screen.queryByTestId('add-security-key-form')).not.toBeInTheDocument();
        expect(onChange).toHaveBeenCalled();
    });

    it('keeps Continue dead until six digits are typed', async () => {
        serve({ keys: [] });
        const user = userEvent.setup();
        render(withQueryClient(<SecurityKeysCard {...WITH_APP} />));
        await user.click(await screen.findByRole('button', { name: /Add security key/ }));
        await user.type(screen.getByLabelText(/Code from your authenticator app/), '12345');
        expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled();
    });

    it('a wrong code is named, and the key is never asked', async () => {
        serve({ keys: [] }, {
            '/registration/options': () => json({ error: 'Invalid code', code: 'invalid_code' }, 400),
        });
        const user = userEvent.setup();
        render(withQueryClient(<SecurityKeysCard {...WITH_APP} />));
        await user.click(await screen.findByRole('button', { name: /Add security key/ }));
        await user.type(screen.getByLabelText(/Code from your authenticator app/), '000000');
        await user.click(screen.getByRole('button', { name: 'Continue' }));

        expect(await screen.findByRole('alert')).toHaveTextContent('Invalid code. Please try again.');
        expect(vi.mocked(startRegistration)).not.toHaveBeenCalled();
        expect(screen.getByTestId('add-security-key-form')).toBeInTheDocument();
    });

    it('a closed browser prompt reads as cancelled, not as a broken key', async () => {
        serve({ keys: [] });
        vi.mocked(startRegistration).mockRejectedValueOnce(Object.assign(new Error('closed'), { name: 'NotAllowedError' }));
        const user = userEvent.setup();
        render(withQueryClient(<SecurityKeysCard {...WITH_APP} />));
        await user.click(await screen.findByRole('button', { name: /Add security key/ }));
        await user.type(screen.getByLabelText(/Code from your authenticator app/), '123456');
        await user.click(screen.getByRole('button', { name: 'Continue' }));

        expect(await screen.findByRole('alert')).toHaveTextContent('The security key prompt was closed or timed out.');
        expect(sent('/registration/verify')).toHaveLength(0);
    });

    it('removes a key only after a confirmation', async () => {
        const onChange = vi.fn();
        serve({ keys: [KEY_HERE] });
        const user = userEvent.setup();
        render(withQueryClient(<SecurityKeysCard {...WITH_APP} onChange={onChange} />));
        await user.click(await screen.findByRole('button', { name: 'Remove' }));
        expect(screen.getByText(/You can still sign in with your other second factors/)).toBeInTheDocument();
        expect(fetchMock.mock.calls.some((call) => initOf(call)?.method === 'DELETE')).toBe(false);

        await user.click(screen.getAllByRole('button', { name: 'Remove' }).at(-1)!);
        await waitFor(() => expect(screen.getByText('No security keys yet.')).toBeInTheDocument());
        expect(fetchMock.mock.calls.find((call) => initOf(call)?.method === 'DELETE')?.[0]).toBe('/auth/mfa/security-keys/k1');
        expect(onChange).toHaveBeenCalled();
    });

    it('in a browser without WebAuthn, says so instead of offering to add', async () => {
        vi.mocked(browserSupportsWebAuthn).mockReturnValue(false);
        serve({ keys: [] });
        render(withQueryClient(<SecurityKeysCard {...WITH_APP} />));
        expect(await screen.findByText(/This browser cannot use security keys here/)).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /Add security key/ })).not.toBeInTheDocument();
    });

});

describe('SecurityKeysCard, whichever factors the account has', () => {
    it('on an account without 2FA, asks no proof and passes the recovery codes up', async () => {
        const onRecoveryCodes = vi.fn();
        const state = { keys: [] as unknown[] };
        serve(state, { '/registration/verify': () => { state.keys = [KEY_HERE]; return json({ key: KEY_HERE, recoveryCodes: ['aaaa-bbbb'] }); } });
        const user = userEvent.setup();
        render(withQueryClient(<SecurityKeysCard mfaEnabled={false} totpEnabled={false} onRecoveryCodes={onRecoveryCodes} />));
        await user.click(await screen.findByRole('button', { name: /Add security key/ }));
        expect(screen.getByText(/This key turns on two-factor authentication/)).toBeInTheDocument();
        expect(screen.queryByLabelText(/Code from your authenticator app/)).not.toBeInTheDocument();
        await user.click(screen.getByRole('button', { name: 'Continue' }));

        await waitFor(() => expect(onRecoveryCodes).toHaveBeenCalledWith(['aaaa-bbbb']));
        expect(sent('/registration/options')).toEqual([{}]);
    });

    it('on a key-only account, proves with an existing key before touching the new one', async () => {
        serve({ keys: [KEY_HERE] });
        const user = userEvent.setup();
        render(withQueryClient(<SecurityKeysCard mfaEnabled totpEnabled={false} />));
        await user.click(await screen.findByRole('button', { name: /Add security key/ }));
        expect(screen.getByText('First touch a key you already registered, then the new one.')).toBeInTheDocument();
        await user.click(screen.getByRole('button', { name: 'Continue' }));

        await waitFor(() => expect(sent('/registration/verify')).toHaveLength(1));
        expect(vi.mocked(startAuthentication)).toHaveBeenCalledWith({ optionsJSON: { challenge: 'proof', rpId: 'localhost' } });
        expect(sent('/registration/options')).toEqual([{ securityKey: { id: 'old', rawId: 'old', type: 'public-key', response: {} } }]);
    });

    it('a key-only account whose keys do not work here proves with a recovery code', async () => {
        serve({ keys: [KEY_ELSEWHERE] });
        const user = userEvent.setup();
        render(withQueryClient(<SecurityKeysCard mfaEnabled totpEnabled={false} />));
        await user.click(await screen.findByRole('button', { name: /Add security key/ }));
        await user.type(screen.getByLabelText('Recovery code'), 'a1b2-c3d4');
        await user.click(screen.getByRole('button', { name: 'Continue' }));
        await waitFor(() => expect(sent('/registration/options')).toEqual([{ code: 'a1b2-c3d4' }]));
        expect(vi.mocked(startAuthentication)).not.toHaveBeenCalled();
    });

    it('says why the only key cannot be removed', async () => {
        serve({ keys: [KEY_HERE] }, {
            '/security-keys/k1': () => json({ error: 'x', code: 'last_factor' }, 409),
        });
        const user = userEvent.setup();
        render(withQueryClient(<SecurityKeysCard mfaEnabled totpEnabled={false} />));
        await user.click(await screen.findByRole('button', { name: 'Remove' }));
        await user.click(screen.getAllByRole('button', { name: 'Remove' }).at(-1)!);
        expect(await screen.findByRole('alert')).toHaveTextContent('This key is your only second factor.');
    });
});
