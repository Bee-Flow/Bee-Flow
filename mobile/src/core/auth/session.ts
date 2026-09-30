/**
 * The sign-in state machine's transitions, apart from the React state that
 * holds the result: which stage a session resolves to, and which stage a
 * login answer leads to. AuthProvider owns the state and the side effects of
 * entering a stage; these decide which stage it is.
 */

import { loadServerUrl } from '@/core/api/server';

import { fetchCurrentUser } from './api';
import { serverAnsweredAboutSession } from './reachability';
import { clearSessionToken, primeSessionToken } from './sessionToken';
import type { AuthStage, CurrentUserResponse, LoginResponse } from './types';
import * as vault from './vault';

/**
 * Resolve the current session into a stage, or null when a newer resolve has
 * started meanwhile (`isCurrent` turned false) and this one must stay quiet —
 * a slow run that ends in "unreachable" must not land after a later one that
 * reached "signed-in".
 */
export async function resolveSession(isCurrent: () => boolean): Promise<AuthStage | null> {
    const server = await loadServerUrl();
    if (!isCurrent()) return null;
    if (!server) return { kind: 'needs-server' };
    // Before anything is fetched: an SSO session authenticates by header, so a
    // first request without the token would read as signed-out.
    await primeSessionToken(server);
    try {
        const me = await fetchCurrentUser();
        if (!isCurrent()) return null;
        return await stageForCurrentUser(me, isCurrent);
    } catch (err) {
        // Only the server answering about THIS session signs anyone out. A
        // five-second tunnel is `unreachable`: the session, cookie and token
        // are all still good, the app just could not ask.
        if (!isCurrent()) return null;
        if (serverAnsweredAboutSession(err)) {
            return { kind: 'signed-out', oauthProviders: [], isOAuthConfigured: false };
        }
        return { kind: 'unreachable' };
    }
}

/** The stage /auth/user's answer puts this device in (null when superseded). */
async function stageForCurrentUser(
    me: CurrentUserResponse,
    isCurrent: () => boolean,
): Promise<AuthStage | null> {
    if (!me.authenticated || !me.user) {
        // The server says nobody is signed in, so a token we still hold stands
        // for nothing and would override a later cookie sign-in.
        await clearSessionToken();
        if (!isCurrent()) return null;
        return {
            kind: 'signed-out',
            oauthProviders: me.oauthProviders ?? [],
            isOAuthConfigured: Boolean(me.isOAuthConfigured),
        };
    }
    // Encryption gates first: without a DEK most of the product is ciphertext.
    if (me.needsEncryptionSetup) return { kind: 'encryption-setup-required' };
    if (me.needsEncryptionPin) return { kind: 'encryption-pin-required' };
    // A session can outlive the process. With the vault empty but a key stored
    // behind biometrics for this user, ask for a fingerprint.
    if (!vault.getDek() && me.encryptionEnabled) {
        const owner = await vault.persistedOwner();
        if (!isCurrent()) return null;
        if (owner && owner === me.user.id) return { kind: 'locked', user: me.user };
    }
    return { kind: 'signed-in', user: me.user };
}

/**
 * The stage a password or MFA login answer leads to. The success-ish shapes
 * are mutually exclusive and each is a different next screen; anything else
 * is a failure and throws the server's message.
 */
export function stageForLoginResult(result: LoginResponse, username: string, fallbackError: string): AuthStage {
    if (result.mfaRequired) return { kind: 'mfa-required', username, methods: result.mfaMethods };
    if (result.mfaSetupRequired) return { kind: 'mfa-setup-required' };
    if (result.emailVerificationRequired) {
        return { kind: 'email-verification-required', email: username.includes('@') ? username : '' };
    }
    if (result.pendingApproval && result.user) return { kind: 'pending-approval', user: result.user };
    if (result.success && result.user) return { kind: 'signed-in', user: result.user };
    throw new Error(result.error || fallbackError);
}

/**
 * The stage after /auth/user answered a fresh sign-in. A login answer carries
 * a thin user (no orgRole, organisation, feature flags or Simple Mode), which
 * the gates would read as "none"; the richer copy replaces it — but only while
 * the same person is still signed in, so a late answer cannot resurrect a
 * session that has since ended or changed hands.
 */
export function withFreshUser(current: AuthStage, me: CurrentUserResponse): AuthStage {
    if (current.kind !== 'signed-in' || !me.authenticated || !me.user) return current;
    if (me.user.id !== current.user.id) return current;
    return { kind: 'signed-in', user: me.user };
}
