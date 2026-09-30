/**
 * The sign-in readers. What is pinned is how an absent or partial answer
 * reads, because the stage machine branches on these fields: no body is
 * signed out, a partial user (the OPAQUE answer) stays falsy where it is
 * missing, and a wrapped key is all three parts or nothing.
 */

import {
    readCurrentUser,
    readLoginResponse,
    readOpaqueLoginFinish,
    readOpaqueLoginStart,
    readPermissions,
    readSessionTokenGrant,
    readUser,
} from './readers';

describe('readCurrentUser', () => {
    it('reads no body as signed out, with no user', () => {
        expect(readCurrentUser(null)).toMatchObject({ authenticated: false, user: undefined });
    });

    it('keeps the user and the encryption flags', () => {
        const me = readCurrentUser({
            authenticated: true,
            user: { id: 'u1', displayName: 'Ada', isAdmin: false, role: 'user', provider: 'local', avatar: null },
            needsEncryptionPin: true,
            oauthProviders: ['google'],
        });
        expect(me.user).toMatchObject({ id: 'u1', displayName: 'Ada', provider: 'local', avatar: null });
        expect(me.needsEncryptionPin).toBe(true);
        expect(me.oauthProviders).toEqual(['google']);
    });
});

describe('readCurrentUser: the Nextcloud binding', () => {
    it('hangs ncOrg on the user, and reads a binding without an instance as none', () => {
        const bound = readCurrentUser({
            authenticated: true,
            user: { id: 'u1' },
            ncOrg: { instanceId: 'nc-1', baseUrl: 'https://cloud.example', syncMode: 'mirror_all', lastSyncAt: null },
        });
        expect(bound.user?.ncOrg).toEqual({ instanceId: 'nc-1', baseUrl: 'https://cloud.example', syncMode: 'mirror_all', lastSyncAt: null });
        expect(readCurrentUser({ authenticated: true, user: { id: 'u1' }, ncOrg: { baseUrl: 'x' } }).user?.ncOrg).toBeNull();
    });
});

describe('readCurrentUser: the organisation and feature flags', () => {
    it('hangs the sibling organisation and flags on the user, as the web does', () => {
        const me = readCurrentUser({
            authenticated: true,
            user: { id: 'u1', orgRole: 'org_admin', organizationId: 'o1', simpleMode: true },
            organization: { id: 'o1', name: 'Acme', logo: '/api/org-logo/o1', extra: 1 },
            featureFlags: { notebooks: false, projects: true, deploymentMode: 'self-hosted', bogus: 'x' },
            isConsumerAccount: false,
        });
        expect(me.organization).toEqual({ id: 'o1', name: 'Acme', logo: '/api/org-logo/o1' });
        expect(me.user).toMatchObject({
            orgRole: 'org_admin',
            organizationId: 'o1',
            simpleMode: true,
            organization: { id: 'o1', name: 'Acme', logo: '/api/org-logo/o1' },
            featureFlags: { notebooks: false, projects: true, deploymentMode: 'self-hosted' },
        });
        expect(me.user?.featureFlags).not.toHaveProperty('bogus');
        expect(me.isConsumerAccount).toBe(false);
    });

    it('reads a personal account as no organisation, and absent flags as absent (= on)', () => {
        const me = readCurrentUser({ authenticated: true, user: { id: 'u1' }, organization: null });
        expect(me.user?.organization).toBeNull();
        expect(me.user?.featureFlags).toBeUndefined();
        expect(readCurrentUser({ authenticated: true, user: { id: 'u1' }, organization: { name: 'x' } }).organization).toBeNull();
    });
});

describe('readUser', () => {
    it('reads a partial user as empty and false, never as a guessed provider', () => {
        const user = readUser({ id: 'u1', displayName: null, role: 'user' });
        expect(user).toMatchObject({ id: 'u1', displayName: '', isAdmin: false, provider: '', email: undefined });
    });
});

describe('readPermissions', () => {
    it('is null without a body and lists default to empty', () => {
        expect(readPermissions(null)).toBeNull();
        expect(readPermissions({ permissions: ['all'], betaFeatures: ['x'] })).toMatchObject({
            permissions: ['all'],
            groups: [],
            betaFeatures: ['x'],
        });
    });
});

describe('the login answers', () => {
    it('keeps the OPAQUE hint and leaves unsent flags unsaid', () => {
        expect(readLoginResponse({ useOpaque: true })).toMatchObject({ useOpaque: true, success: undefined });
        expect(readLoginResponse(undefined).useOpaque).toBeUndefined();
        expect(readLoginResponse({ mfaRequired: true, mfaMethods: ['totp', 7, 'security_key'] }).mfaMethods).toEqual(['totp', 'security_key']);
    });

    it('reads a wrapped key whole, or not at all', () => {
        const start = readOpaqueLoginStart({
            loginResponse: 'lr',
            loginId: 'l1',
            wrappedDEK: { iv: 'a', authTag: 'b', data: 'c', extra: 1 },
            recoveryWrappedDEK: null,
        });
        expect(start).toEqual({
            loginResponse: 'lr',
            loginId: 'l1',
            wrappedDEK: { iv: 'a', authTag: 'b', data: 'c' },
            recoveryWrappedDEK: null,
        });
        expect(readOpaqueLoginStart('nope')).toBeNull();
    });

    it('reads the finish as failed unless it says success', () => {
        expect(readOpaqueLoginFinish({ user: { id: 'u1' } })?.success).toBe(false);
        expect(readOpaqueLoginFinish({ success: true, user: { id: 'u1' }, sessionKey: 'k' })).toMatchObject({
            success: true,
            sessionKey: 'k',
            user: { id: 'u1' },
        });
    });
});

describe('readSessionTokenGrant', () => {
    it('reads the lifetime as a number, and a missing token as none', () => {
        expect(readSessionTokenGrant({ token: 't', expiresIn: '3600' })).toEqual({ token: 't', expiresIn: 3600 });
        expect(readSessionTokenGrant({})?.token).toBeUndefined();
    });
});
