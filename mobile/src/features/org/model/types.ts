/**
 * The organisation, its people, its Privacy Shield and its data-subject
 * requests — as the route handlers send them (auth/admin/orgRoutes.js,
 * userRoutes.js, routes/orgPrivacyShield.js, routes/dsr.js).
 */

/**
 * `GET /auth/organizations/:id` — parseOrg (stores/user/organizations.js)
 * over the row. PUT takes a partial patch of `OrgPatch`'s keys and refuses any
 * other key (ORG_UPDATE_ALLOWED_KEYS in auth/admin/orgRoutes.js).
 */
export interface Organization {
    id: string;
    name: string;
    description?: string;
    tagline?: string;
    email?: string;
    phone?: string;
    website?: string;
    address?: string;
    billingLine2?: string;
    billingPostalCode?: string;
    billingCity?: string;
    billingCountry?: string;
    kvk?: string;
    vat?: string;
    logo?: string | null;
    footerText?: string;
    allowSignup?: boolean;
    /** 'password' | 'google' | 'microsoft', chosen once; unset until then. */
    authMethod?: string | null;
    autoApproveSSO?: boolean;
    /** Self-hosted only: sign-ups from these domains join this organisation. */
    allowedDomains?: string[];
    /** Pooled (true, the default) or per-user plan quotas. */
    usagePooled?: boolean;
}

/** The fields PUT /auth/organizations/:id accepts from an org admin. */
export type OrgPatch = Partial<
    Pick<
        Organization,
        | 'name'
        | 'description'
        | 'tagline'
        | 'email'
        | 'phone'
        | 'website'
        | 'address'
        | 'billingLine2'
        | 'billingPostalCode'
        | 'billingCity'
        | 'billingCountry'
        | 'kvk'
        | 'vat'
        | 'footerText'
        | 'allowSignup'
        | 'autoApproveSSO'
        | 'allowedDomains'
        | 'usagePooled'
    > & { authMethod: string }
>;

/** `GET /auth/users`, scoped to the caller's orgs unless they are super-admin. */
export interface OrgMember {
    id: string;
    username?: string;
    displayName?: string;
    firstName?: string;
    lastName?: string;
    email?: string;
    role?: string;
    orgRole?: string;
    organizationId?: string;
    avatar?: string | null;
    avatarType?: string | null;
    groups?: string[] | string;
    isSystem?: boolean;
    disabled?: boolean;
}

/** `GET /auth/groups`. */
export interface UserGroup {
    id: string;
    name: string;
    description?: string;
    organizationId?: string;
    role?: string;
    permissions?: string[];
}

/** A row of `GET /api/dsr/requests`. */
export interface DsrRequest {
    id: number;
    status: string;
    request_type: string;
    subject_email?: string;
    created_at: string;
    fulfilled_at?: string | null;
    notes?: string;
}

/** `POST /api/dsr/requests` — public, rate-limited to 5/hour per IP. The id is
 *  the reference a requester quotes; null when the server sent none. */
export interface DsrSubmitResponse {
    id: number | null;
    created_at: string;
    status_url: string;
    ack: string;
}

/** `GET|PUT /api/org-privacy-shield/user/me`. Defaults are SECURE — an account
 *  that has never opened this panel is protected, and `implicitDefault` marks
 *  exactly that case so the UI does not claim the user chose these. */
export interface UserShield {
    enabled: boolean;
    euModeEnabled: boolean;
    disableSearchOnUpload: boolean;
    piiDetectionEnabled: boolean;
    piiDetectionCategories: string[];
    piiDetectionConfidenceThreshold: number;
    /** 'tokenize' | 'block'. */
    piiDetectionAction: string;
    /** 'fail_closed' | 'fail_open'. */
    piiFailureMode: string;
    showRawPayload: boolean;
    implicitDefault?: boolean;
    updatedAt?: string;
}

/** `GET /api/org-privacy-shield/user/guard-status` — is the PII Guard service
 *  reachable at all? Without it, detection silently does nothing. */
export interface GuardStatus {
    configured: boolean;
    reachable: boolean;
}

/** `GET|PUT /api/org-privacy-shield/:orgId`. */
export interface OrgShield {
    enabled: boolean;
    collectionIds: string[];
    scope: { userInput: boolean; agentOutput: boolean };
    action: string;
    euModeEnabled: boolean;
    piiDetectionCategories: string[];
    piiDetectionConfidenceThreshold: number;
    piiDetectionAction: string;
    piiFailureMode: string;
    monitorIntegrations: boolean;
    applyToAutomations: boolean;
    piiAllowTerms: string[];
    piiAllowPublicOrgs: boolean;
    /** Present when the org's tier forces a narrower setting than the stored one. */
    clamped_fields?: string[];
    clamped_tier?: string;
    stalenessWarnings?: string[];
}

/** `GET /api/license/health` (routes/license.js): org-admin only. */
export interface LicenseHealth {
    refresher: { enabled: boolean; lastTickAt?: string | null; lastError?: string | null };
    crl: { enabled: boolean; lastPollAt?: string | null };
    dunning: { past_due_count: number; suspended_count: number };
    now: string;
}
