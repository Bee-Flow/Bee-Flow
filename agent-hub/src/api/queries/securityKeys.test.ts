import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * The wire contract and the browser seam of security keys. The WebAuthn
 * browser calls are stubbed (jsdom has no authenticator); what is pinned is
 * the order of the requests, what each one carries, that none of them is
 * retried (a challenge answers once), and how every failure folds into a code.
 */

vi.mock('../../utils/helpers', () => ({ API_BASE: '', authFetch: vi.fn() }));
vi.mock('@simplewebauthn/browser', () => ({
    browserSupportsWebAuthn: vi.fn(() => true),
    startRegistration: vi.fn(async () => ({ id: 'cred', rawId: 'cred', type: 'public-key', response: {} })),
    startAuthentication: vi.fn(async () => ({ id: 'cred', rawId: 'cred', type: 'public-key', response: {} })),
}));

import { authFetch } from '../../utils/helpers';
import { startAuthentication, startRegistration } from '@simplewebauthn/browser';
import { ApiError } from '../client';
import {
    addSecurityKey,
    isUsableHere,
    parseSecurityKeys,
    proveWithSecurityKey,
    securityKeyErrorCode,
    signInWithSecurityKey,
} from './securityKeys';

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

const calls = () => fetchMock.mock.calls.map(([url, rawInit]) => {
    const init = rawInit as RequestInit | undefined;
    return { url: String(url), method: init?.method, body: init?.body ? JSON.parse(String(init.body)) : undefined };
});

afterEach(() => { fetchMock.mockReset(); vi.clearAllMocks(); });

describe('parseSecurityKeys', () => {
    it('keeps well-formed keys and drops the rest', () => {
        expect(parseSecurityKeys({
            keys: [
                { id: 'k1', name: 'YubiKey', rpId: 'beeflow.nl', createdAt: '2026-09-01T00:00:00Z', lastUsedAt: null, publicKey: 'nope' },
                { id: '', rpId: 'beeflow.nl' },
                { id: 'k3' },
                'junk',
            ],
        })).toEqual([{ id: 'k1', name: 'YubiKey', rpId: 'beeflow.nl', createdAt: '2026-09-01T00:00:00Z', lastUsedAt: null }]);
    });

    it('reads a body without a list as no keys', () => {
        expect(parseSecurityKeys(null)).toEqual([]);
        expect(parseSecurityKeys({ keys: 'x' })).toEqual([]);
    });
});

describe('isUsableHere', () => {
    it('matches the RP host and its subdomains, not look-alikes', () => {
        expect(isUsableHere('beeflow.nl', 'beeflow.nl')).toBe(true);
        expect(isUsableHere('beeflow.nl', 'www.beeflow.nl')).toBe(true);
        expect(isUsableHere('beeflow.nl', 'notbeeflow.nl')).toBe(false);
        expect(isUsableHere('beeflow.nl', 'localhost')).toBe(false);
    });
});

describe('securityKeyErrorCode', () => {
    it('passes known server codes through, and words 429 as rate limiting', () => {
        expect(securityKeyErrorCode(new ApiError('x', { status: 400, body: { code: 'invalid_code' } }))).toBe('invalid_code');
        expect(securityKeyErrorCode(new ApiError('x', { status: 401, body: { code: 'mfa_attempts_exhausted' } }))).toBe('mfa_attempts_exhausted');
        expect(securityKeyErrorCode(new ApiError('x', { status: 429, body: {} }))).toBe('rate_limited');
        expect(securityKeyErrorCode(new ApiError('x', { status: 500, body: { code: 'something_new' } }))).toBe('failed');
    });

    it('folds browser failures into cancelled, already registered and unavailable', () => {
        expect(securityKeyErrorCode(Object.assign(new Error('x'), { name: 'NotAllowedError' }))).toBe('cancelled');
        expect(securityKeyErrorCode(Object.assign(new Error('x'), { code: 'ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED' }))).toBe('already_registered');
        expect(securityKeyErrorCode(Object.assign(new Error('x'), { code: 'ERROR_INVALID_DOMAIN' }))).toBe('webauthn_unavailable');
        expect(securityKeyErrorCode(new Error('boom'))).toBe('failed');
    });
});

describe('addSecurityKey', () => {
    it('asks for options with the proof and name, lets the key answer, then sends the answer back', async () => {
        const options = { challenge: 'abc', rp: { id: 'beeflow.nl' } };
        fetchMock
            .mockResolvedValueOnce(json({ options }))
            .mockResolvedValueOnce(json({ key: { id: 'k1' } }));

        await expect(addSecurityKey({ name: 'YubiKey 5C', proof: { code: '123456' } })).resolves.toEqual({});

        expect(vi.mocked(startRegistration)).toHaveBeenCalledWith({ optionsJSON: options });
        expect(calls()).toEqual([
            { url: '/auth/mfa/security-keys/registration/options', method: 'POST', body: { code: '123456', name: 'YubiKey 5C' } },
            { url: '/auth/mfa/security-keys/registration/verify', method: 'POST', body: { response: { id: 'cred', rawId: 'cred', type: 'public-key', response: {} } } },
        ]);
    });

    it('a first key sends no proof and hands back the recovery codes it earned', async () => {
        fetchMock
            .mockResolvedValueOnce(json({ options: { challenge: 'abc' } }))
            .mockResolvedValueOnce(json({ key: { id: 'k1' }, recoveryCodes: ['aaaa-bbbb', 7] }));
        await expect(addSecurityKey({})).resolves.toEqual({ recoveryCodes: ['aaaa-bbbb'] });
        expect(calls()[0].body).toEqual({});
    });

    it('does not retry a verify that failed on the server: the challenge is spent', async () => {
        fetchMock
            .mockResolvedValueOnce(json({ options: { challenge: 'abc' } }))
            .mockResolvedValueOnce(json({ error: 'boom' }, 502));
        await expect(addSecurityKey({ proof: { code: '123456' } })).rejects.toBeInstanceOf(ApiError);
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('stops before the browser prompt when the code is wrong', async () => {
        fetchMock.mockResolvedValueOnce(json({ error: 'Invalid code', code: 'invalid_code' }, 400));
        const err = await addSecurityKey({ proof: { code: '000000' } }).catch((e) => e);
        expect(securityKeyErrorCode(err)).toBe('invalid_code');
        expect(vi.mocked(startRegistration)).not.toHaveBeenCalled();
    });
});

describe('proveWithSecurityKey', () => {
    it('gets a proof challenge and returns the key answer to send along', async () => {
        fetchMock.mockResolvedValueOnce(json({ options: { challenge: 'p', rpId: 'beeflow.nl' } }));
        await expect(proveWithSecurityKey()).resolves.toEqual({
            securityKey: { id: 'cred', rawId: 'cred', type: 'public-key', response: {} },
        });
        expect(calls()).toEqual([{ url: '/auth/mfa/security-keys/proof/options', method: 'POST', body: {} }]);
    });
});

describe('signInWithSecurityKey', () => {
    it('fetches a challenge, lets the key answer, and returns the login body', async () => {
        const options = { challenge: 'xyz', rpId: 'beeflow.nl' };
        fetchMock
            .mockResolvedValueOnce(json({ options }))
            .mockResolvedValueOnce(json({ success: true, user: { id: 'u1' } }));

        await expect(signInWithSecurityKey()).resolves.toEqual({ success: true, user: { id: 'u1' } });
        expect(vi.mocked(startAuthentication)).toHaveBeenCalledWith({ optionsJSON: options });
        expect(calls().map((c) => c.url)).toEqual(['/auth/mfa/security-key/options', '/auth/mfa/security-key/verify-login']);
    });

    it('surfaces a closed prompt as cancelled and sends nothing further', async () => {
        fetchMock.mockResolvedValueOnce(json({ options: { challenge: 'xyz' } }));
        vi.mocked(startAuthentication).mockRejectedValueOnce(Object.assign(new Error('closed'), { name: 'NotAllowedError' }));
        const err = await signInWithSecurityKey().catch((e) => e);
        expect(securityKeyErrorCode(err)).toBe('cancelled');
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });
});
