/**
 * The shapes /auth/user, /auth/admin-login and /auth/my-permissions actually
 * return. Written from the route handlers, not guessed:
 *   server/auth/login/currentUserRoutes.js      → CurrentUserResponse
 *   server/auth/login/finalizeLogin.js          → LoginResponse
 *   server/auth/login/myPermissionsRoutes.js    → PermissionsResponse
 *   server/auth/opaqueRoutes.js                 → OpaqueLoginResponse
 */

/**
 * `organization` on /auth/user: the org's branding for a self-hosted
 * white-label sidebar. Null for a personal account.
 */
export interface OrgBrand {
    id: string;
    name: string | null;
    /** A server-relative path (`/api/...`) or an absolute URL. */
    logo: string | null;
}

/**
 * `ncOrg` on /auth/user: present iff the org was provisioned through
 * Nextcloud, whose identity then replaces the org's own sign-in settings.
 */
export interface NcOrgBinding {
    instanceId: string;
    baseUrl: string | null;
    syncMode: string;
    lastSyncAt: string | null;
}

/**
 * `featureFlags` on /auth/user: installation switches from env and config.
 * Every one of them reads as ON when absent (the server writes
 * `x !== false`), so a gate asks `flags.x !== false`, never `flags.x`.
 */
export interface FeatureFlags {
    tasks?: boolean;
    monitoring?: boolean;
    meeting_notes?: boolean;
    templates?: boolean;
    notebooks?: boolean;
    projects?: boolean;
    askAi?: boolean;
    export?: boolean;
    openInNotebook?: boolean;
    notebooksMenu?: boolean;
    /** 'cloud' or 'self-hosted' (server env DEPLOYMENT_MODE). */
    deploymentMode?: string;
}

export interface User {
    id: string;
    displayName: string;
    firstName?: string;
    lastName?: string;
    email?: string;
    isAdmin: boolean;
    role: string;
    avatar?: string | null;
    avatarType?: string | null;
    /** 'local' for password/OPAQUE, otherwise the SSO provider name. */
    provider: string;
    organizationId?: string;
    orgRole?: string;
    /** Personal preference that strips the UI down to chat + agents. */
    simpleMode?: boolean;
    /**
     * The integrations the organisation offers (its own list, else the
     * installation's default). Absent means all of them, as on the web.
     */
    enabledIntegrations?: string[];
    /**
     * The next two are SIBLINGS of `user` on /auth/user, not fields of it;
     * readCurrentUser hangs them on the user the way the web's
     * applyAuthSession does, because the signed-in stage carries only the
     * user. A login answer has neither, which is why AuthProvider re-reads
     * /auth/user after a sign-in.
     */
    organization?: OrgBrand | null;
    featureFlags?: FeatureFlags;
    /** A sibling on /auth/user too, hung here the same way. */
    ncOrg?: NcOrgBinding | null;
}

export interface CurrentUserResponse {
    authenticated: boolean;
    user?: User;
    isOAuthConfigured?: boolean;
    oauthProviders?: string[];
    encryptionEnabled?: boolean;
    needsEncryptionSetup?: boolean;
    needsEncryptionPin?: boolean;
    noOrganization?: boolean;
    /** A cloud account with no organisation: the consumer plan applies. */
    isConsumerAccount?: boolean;
    organization?: OrgBrand | null;
    featureFlags?: FeatureFlags;
    ncOrg?: NcOrgBinding | null;
}

/**
 * /auth/admin-login. The four success-ish shapes are mutually exclusive and
 * every one of them is a different next screen, which is why the login state
 * machine below is a machine and not a boolean.
 */
export interface LoginResponse {
    success?: boolean;
    user?: User;
    /** The account moved to OPAQUE; retry the whole login over that protocol. */
    useOpaque?: boolean;
    kdfMode?: string;
    /** Password verified, second factor still owed. */
    mfaRequired?: boolean;
    /**
     * The factors that account has: 'totp', 'security_key', or both. Absent on
     * servers from before security keys, where it was always the app.
     * Recovery codes always work and are not listed.
     */
    mfaMethods?: string[];
    /** An admin requires 2FA and this account has not enrolled yet. */
    mfaSetupRequired?: boolean;
    /** Credentials fine, email not confirmed. */
    emailVerificationRequired?: boolean;
    /** Signed in, but the org has not approved the account yet. */
    pendingApproval?: boolean;
    /**
     * Present only when the server just created or migrated the DEK. It is the
     * one and only time the user can see it, so the app must not swallow it.
     */
    recoveryKey?: string;
    error?: string;
}

export interface PermissionsResponse {
    permissions: string[];
    groups: string[];
    organizations: string[];
    allowedAgentTypes: string[];
    /** The beta feature ids the entitlements grant (an array on the wire). */
    betaFeatures?: string[];
    /** Entitlement map the UI gates features on. */
    canUseFeature?: Record<string, boolean>;
    orgRole?: string;
}

/** /auth/opaque/login/start */
export interface OpaqueLoginStartResponse {
    loginResponse: string;
    loginId: string;
    wrappedDEK: { iv: string; authTag: string; data: string } | null;
    recoveryWrappedDEK: { iv: string; authTag: string; data: string } | null;
}

/** /auth/opaque/login/finish */
export interface OpaqueLoginFinishResponse {
    success: boolean;
    user: User;
    /** Needed to encrypt the DEK back to the server for the session's AI work. */
    sessionKey: string;
}

/**
 * Where the sign-in flow currently stands. Each state is a screen.
 *
 * `needs-server` comes first because, unlike the web app, this client does not
 * know which Bee Flow it belongs to until someone tells it.
 */
export type AuthStage =
    | { kind: 'loading' }
    | { kind: 'needs-server' }
    /**
     * The server could not be reached — NOT a statement that you are signed
     * out. Your session is untouched and the app retries by itself; this
     * exists so a tunnel stops looking like a logout.
     */
    | { kind: 'unreachable' }
    | { kind: 'signed-out'; oauthProviders: string[]; isOAuthConfigured: boolean }
    | { kind: 'mfa-required'; username: string; methods?: string[] }
    | { kind: 'mfa-setup-required' }
    | { kind: 'email-verification-required'; email: string }
    | { kind: 'encryption-setup-required' }
    | { kind: 'encryption-pin-required' }
    | { kind: 'pending-approval'; user: User }
    | { kind: 'locked'; user: User }
    | { kind: 'signed-in'; user: User };
