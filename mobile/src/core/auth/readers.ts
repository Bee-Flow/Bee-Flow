/**
 * Contract readers for the sign-in answers (types.ts names each route).
 *
 * Defaults read the way an absent field did before there were readers: '' and
 * false where the app tests truthiness, undefined where it tests presence. A
 * user keeps exactly the fields in `User`; the OPAQUE and login answers carry
 * a partial one (no provider, no isAdmin), which reads as '' and false.
 */

import { field, nullable, shapeOf, type FieldReader } from '@/core/api/contract';
import type { WrappedKey } from '@/core/crypto/keys';

import type {
    CurrentUserResponse,
    FeatureFlags,
    LoginResponse,
    NcOrgBinding,
    OpaqueLoginFinishResponse,
    OpaqueLoginStartResponse,
    OrgBrand,
    PermissionsResponse,
    User,
} from './types';

/** An object read with `read`, or undefined when there is none. */
function optShape<T>(read: (raw: unknown) => T): FieldReader<T | undefined> {
    const orNull = nullable(read);
    return (value) => orNull(value) ?? undefined;
}

export const readUser: (raw: unknown) => User = shapeOf({
    id: field.str(''),
    displayName: field.str(''),
    firstName: field.optStr,
    lastName: field.optStr,
    email: field.optStr,
    isAdmin: field.bool(false),
    role: field.str(''),
    avatar: field.strOrNull,
    avatarType: field.strOrNull,
    provider: field.str(''),
    organizationId: field.optStr,
    orgRole: field.optStr,
    simpleMode: field.optBool,
    enabledIntegrations: field.optStrArray,
});

const readOrgFields = nullable(shapeOf({ id: field.str(''), name: field.strOrNull, logo: field.strOrNull }));

/** `organization` on /auth/user; an org without an id is no org. */
export function readOrgBrand(raw: unknown): OrgBrand | null {
    const org = readOrgFields(raw);
    return org?.id ? org : null;
}

/** `featureFlags` on /auth/user. An absent flag stays absent: it means ON. */
export const readFeatureFlags: (raw: unknown) => FeatureFlags | undefined = optShape(
    shapeOf({
        tasks: field.optBool,
        monitoring: field.optBool,
        meeting_notes: field.optBool,
        templates: field.optBool,
        notebooks: field.optBool,
        projects: field.optBool,
        askAi: field.optBool,
        export: field.optBool,
        openInNotebook: field.optBool,
        notebooksMenu: field.optBool,
        deploymentMode: field.optStr,
    }),
);

const readNcOrgFields = nullable(
    shapeOf({
        instanceId: field.str(''),
        baseUrl: field.strOrNull,
        syncMode: field.str('mirror_all'),
        lastSyncAt: field.strOrNull,
    }),
);

/** `ncOrg` on /auth/user; a binding without an instance id is no binding. */
export function readNcOrg(raw: unknown): NcOrgBinding | null {
    const nc = readNcOrgFields(raw);
    return nc?.instanceId ? nc : null;
}

const readCurrentUserFields = shapeOf({
    authenticated: field.bool(false),
    user: optShape(readUser),
    isOAuthConfigured: field.optBool,
    oauthProviders: field.optStrArray,
    encryptionEnabled: field.optBool,
    needsEncryptionSetup: field.optBool,
    needsEncryptionPin: field.optBool,
    noOrganization: field.optBool,
    isConsumerAccount: field.optBool,
    organization: readOrgBrand,
    featureFlags: readFeatureFlags,
    ncOrg: readNcOrg,
});

/**
 * GET /auth/user. No body at all reads as signed out.
 *
 * `organization` and `featureFlags` are siblings of `user` on the wire; they
 * are copied onto the user too (the web's applyAuthSession merge), because a
 * stage carries the user and nothing else.
 */
export const readCurrentUser = (raw: unknown): CurrentUserResponse => {
    const me = readCurrentUserFields(raw);
    if (!me.user) return me;
    return {
        ...me,
        user: { ...me.user, organization: me.organization, featureFlags: me.featureFlags, ncOrg: me.ncOrg },
    };
};

export const readPermissions: (raw: unknown) => PermissionsResponse | null = nullable(
    shapeOf({
        permissions: field.strArray,
        groups: field.strArray,
        organizations: field.strArray,
        allowedAgentTypes: field.strArray,
        betaFeatures: field.optStrArray,
        canUseFeature: field.optRecord<Record<string, boolean>>,
        orgRole: field.optStr,
    }),
);

/** POST /auth/admin-login and /auth/mfa/verify-login, and the 400 that says "use OPAQUE". */
export const readLoginResponse: (raw: unknown) => LoginResponse = shapeOf({
    success: field.optBool,
    user: optShape(readUser),
    useOpaque: field.optBool,
    kdfMode: field.optStr,
    mfaRequired: field.optBool,
    mfaMethods: field.optStrArray,
    mfaSetupRequired: field.optBool,
    emailVerificationRequired: field.optBool,
    pendingApproval: field.optBool,
    recoveryKey: field.optStr,
    error: field.optStr,
});

/** A DEK sealed under a key: AES-GCM's three parts, base64. */
export const readWrappedKey: (raw: unknown) => WrappedKey | null = nullable(
    shapeOf({ iv: field.str(''), authTag: field.str(''), data: field.str('') }),
);

export const readOpaqueLoginStart: (raw: unknown) => OpaqueLoginStartResponse | null = nullable(
    shapeOf({
        loginResponse: field.str(''),
        loginId: field.str(''),
        wrappedDEK: readWrappedKey,
        recoveryWrappedDEK: readWrappedKey,
    }),
);

export const readOpaqueLoginFinish: (raw: unknown) => OpaqueLoginFinishResponse | null = nullable(
    shapeOf({ success: field.bool(false), user: readUser, sessionKey: field.str('') }),
);

/** GET /api/session-token: a fresh bridge token and its lifetime in seconds. */
export const readSessionTokenGrant: (raw: unknown) => { token?: string; expiresIn?: number } | null = nullable(
    shapeOf({ token: field.optStr, expiresIn: field.optNum }),
);
