/**
 * The sign-in state machine's transitions, without React. Every branch here is
 * a screen, so each one is pinned: which answer leads where, and that a stale
 * resolve stays quiet instead of throwing a signed-in user back out.
 */

import { ApiError, OfflineError } from '@/core/api/client';
import { loadServerUrl } from '@/core/api/server';

import { fetchCurrentUser } from './api';
import { resolveSession, stageForLoginResult, withFreshUser } from './session';
import { clearSessionToken, primeSessionToken } from './sessionToken';
import type { AuthStage, CurrentUserResponse, User } from './types';
import * as vault from './vault';

jest.mock('@/core/api/server', () => ({ loadServerUrl: jest.fn() }));
jest.mock('./api', () => ({ fetchCurrentUser: jest.fn() }));
jest.mock('./sessionToken', () => ({ clearSessionToken: jest.fn(async () => {}), primeSessionToken: jest.fn(async () => {}) }));
jest.mock('./vault', () => ({ getDek: jest.fn(() => null), persistedOwner: jest.fn(async () => null) }));

const server = loadServerUrl as jest.Mock;
const me = fetchCurrentUser as jest.Mock;
const owner = vault.persistedOwner as jest.Mock;

const ADA: User = { id: 'u1', displayName: 'Ada', isAdmin: false, role: 'user', provider: 'local' };
const current = () => true;

function answer(body: CurrentUserResponse) {
    me.mockResolvedValueOnce(body);
}

beforeEach(() => {
    jest.clearAllMocks();
    server.mockResolvedValue('https://beeflow.example');
});

describe('resolveSession', () => {
    it('asks for a server when none is configured', async () => {
        server.mockResolvedValueOnce(null);
        await expect(resolveSession(current)).resolves.toEqual({ kind: 'needs-server' });
        expect(primeSessionToken).not.toHaveBeenCalled();
    });

    it('signs out, and drops the token, when the server says nobody is signed in', async () => {
        answer({ authenticated: false, oauthProviders: ['google'], isOAuthConfigured: true });
        await expect(resolveSession(current)).resolves.toEqual({
            kind: 'signed-out',
            oauthProviders: ['google'],
            isOAuthConfigured: true,
        });
        expect(clearSessionToken).toHaveBeenCalled();
    });

    it('puts the encryption gates before everything else', async () => {
        answer({ authenticated: true, user: ADA, needsEncryptionSetup: true });
        await expect(resolveSession(current)).resolves.toEqual({ kind: 'encryption-setup-required' });
        answer({ authenticated: true, user: ADA, needsEncryptionPin: true });
        await expect(resolveSession(current)).resolves.toEqual({ kind: 'encryption-pin-required' });
    });

    it('asks for a fingerprint when this user has a key behind biometrics', async () => {
        owner.mockResolvedValueOnce('u1');
        answer({ authenticated: true, user: ADA, encryptionEnabled: true });
        await expect(resolveSession(current)).resolves.toEqual({ kind: 'locked', user: ADA });
    });

    it('signs in otherwise', async () => {
        owner.mockResolvedValueOnce('someone-else');
        answer({ authenticated: true, user: ADA, encryptionEnabled: true });
        await expect(resolveSession(current)).resolves.toEqual({ kind: 'signed-in', user: ADA });
    });

    it('reads a network failure as unreachable, not as a sign-out', async () => {
        me.mockRejectedValueOnce(new OfflineError());
        await expect(resolveSession(current)).resolves.toEqual({ kind: 'unreachable' });
        me.mockRejectedValueOnce(new ApiError('HTTP 502', { status: 502 }));
        await expect(resolveSession(current)).resolves.toEqual({ kind: 'unreachable' });
    });

    it('signs out only when the server answered about this session', async () => {
        me.mockRejectedValueOnce(new ApiError('HTTP 401', { status: 401 }));
        await expect(resolveSession(current)).resolves.toEqual({
            kind: 'signed-out',
            oauthProviders: [],
            isOAuthConfigured: false,
        });
    });

    it('stays quiet once a newer resolve has started', async () => {
        let live = true;
        me.mockImplementationOnce(async () => {
            live = false;
            return { authenticated: true, user: ADA };
        });
        await expect(resolveSession(() => live)).resolves.toBeNull();
    });
});

describe('stageForLoginResult', () => {
    const next = (result: Parameters<typeof stageForLoginResult>[0], username = 'ada@example.nl') =>
        stageForLoginResult(result, username, 'Sign-in failed.');

    it('maps each success-ish answer to its own screen', () => {
        expect(next({ mfaRequired: true })).toEqual({ kind: 'mfa-required', username: 'ada@example.nl' });
        // Which factors the account has, so a security-key account is not asked for an app code.
        expect(next({ mfaRequired: true, mfaMethods: ['security_key'] })).toEqual({
            kind: 'mfa-required',
            username: 'ada@example.nl',
            methods: ['security_key'],
        });
        expect(next({ mfaSetupRequired: true })).toEqual({ kind: 'mfa-setup-required' });
        expect(next({ emailVerificationRequired: true })).toEqual({
            kind: 'email-verification-required',
            email: 'ada@example.nl',
        });
        expect(next({ emailVerificationRequired: true }, 'ada')).toEqual({
            kind: 'email-verification-required',
            email: '',
        });
        expect(next({ pendingApproval: true, user: ADA })).toEqual({ kind: 'pending-approval', user: ADA });
        expect(next({ success: true, user: ADA })).toEqual({ kind: 'signed-in', user: ADA });
    });

    it('throws the server\'s message, or the fallback, for anything else', () => {
        expect(() => next({ error: 'Account disabled' })).toThrow('Account disabled');
        expect(() => next({ success: true })).toThrow('Sign-in failed.');
    });
});

describe('withFreshUser', () => {
    const rich: User = { ...ADA, orgRole: 'org_admin', organizationId: 'o1', simpleMode: true };
    const signedIn: AuthStage = { kind: 'signed-in', user: ADA };

    it('replaces the thin login user with the /auth/user copy', () => {
        expect(withFreshUser(signedIn, { authenticated: true, user: rich })).toEqual({ kind: 'signed-in', user: rich });
    });

    it('leaves a session that ended, changed hands or was never confirmed alone', () => {
        const out: AuthStage = { kind: 'signed-out', oauthProviders: [], isOAuthConfigured: false };
        expect(withFreshUser(out, { authenticated: true, user: rich })).toBe(out);
        expect(withFreshUser(signedIn, { authenticated: true, user: { ...rich, id: 'u2' } })).toBe(signedIn);
        expect(withFreshUser(signedIn, { authenticated: false })).toBe(signedIn);
    });
});
