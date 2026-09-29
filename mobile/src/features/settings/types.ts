/**
 * The shapes the settings, org, admin, usage and support screens read.
 *
 * Written from the route handlers, not guessed. Each block names the file it
 * came from, because almost none of these are inferable from the URL:
 * `/api/branding/effective` returns a *theme*, `/versions/:agentId` is about
 * agents rather than about the app, and `/api/usage/summary` returns SQL
 * aggregate rows straight from Postgres.
 *
 * Numeric aggregates are typed `Numeric = number | string`. node-postgres
 * returns `bigint` and `numeric` columns as STRINGS (no type parser is
 * registered in server/db.js), so `COUNT(*)` and `SUM(estimated_cost)` arrive
 * as `"1423"` and `"18.4402"`. The web app coerces at every read site with
 * `Number(...)`; here `num()` in ./format.ts does it once.
 */

/** A Postgres aggregate as it actually arrives on the wire. */
export type Numeric = number | string;

// ── Branding / theme (server/routes/branding.js + stores/brandingStore.js) ──

/**
 * `GET /api/branding/effective`.
 *
 * `preset` uses the same eight names as ThemeName in src/theme/tokens.ts, plus
 * `custom` — which the mobile app has no palette for and treats as "keep what
 * you have". `allowUserOverride` is the admin's switch: when it is false,
 * `PUT /api/branding/user` answers 403 and the accent is not the user's to
 * change.
 */
export interface EffectiveBranding {
    preset: string;
    accent: string;
    radiusScale: number;
    font: string;
    wallpaperUrl: string | null;
    allowUserOverride: boolean;
    /** 'default' | 'admin' | 'user' — where the winning value came from. */
    source: string;
}

/**
 * `GET /api/branding/public` — the unauthenticated subset, served for the login
 * screen. Same knobs as the effective payload minus the two that only mean
 * something for a known user (`allowUserOverride`, `source`), so a signed-out
 * phone can paint the org's theme instead of guessing from the device.
 */
export type PublicBranding = Omit<EffectiveBranding, 'allowUserOverride' | 'source'>;

/** `PUT /api/branding/user` body. Only these three survive the server's
 *  sanitiser for a non-admin (`allowAllKnobs: false` in brandingStore). */
export interface UserBrandingPatch {
    preset?: string;
    accent?: string;
    wallpaperPreset?: string;
}

export interface UserBrandingResponse {
    override: UserBrandingPatch | null;
    effective: EffectiveBranding;
}

// ── Security (server/auth/mfaRoutes.js, auth/admin/appPasswordRoutes.js) ──

/** `GET /auth/mfa/status`. */
export interface MfaStatus {
    enabled: boolean;
    recoveryCodesRemaining: number;
    /** False for SSO-only accounts — they have no password to change. */
    hasPassword: boolean;
}

/** `POST /auth/mfa/setup`. */
export interface MfaSetup {
    otpauthUrl: string;
    /** Data-URI PNG of the enrolment QR. */
    qr: string;
    secret: string;
    /** Lets the client warn about device clock drift before a code is refused. */
    serverTime: number;
}

/** `POST /auth/mfa/enable` and `/auth/mfa/recovery-codes/regenerate`. */
export interface RecoveryCodesResponse {
    success?: boolean;
    recoveryCodes?: string[];
    error?: string;
}

/** `GET /auth/app-password-status`. */
export interface AppPasswordStatus {
    hasAppPassword?: boolean;
    exists?: boolean;
    createdAt?: string | null;
}

// ── Licence + plan (server/routes/license.js, routes/subscriptions/**) ──

export interface LicenseSummary {
    id: string;
    tier: string;
    issuer?: string;
    issuedAt?: string | null;
    expiresAt?: string | null;
    billingInterval?: string | null;
    lastRefreshAt?: string | null;
    refreshStatus?: string | null;
    revokedAt?: string | null;
    scope?: string | null;
}

/** `GET /api/license/status`. */
export interface LicenseStatus {
    tier: string;
    /** 'license_key' | 'stripe_subscription' | 'server_license' | 'default'. */
    source: string;
    scope?: string | null;
    license: LicenseSummary | null;
    subscription: { status?: string; planName?: string } | null;
    features: string[];
    limits: Record<string, number | null>;
    serverOverride?: boolean;
    serverLicense?: LicenseSummary | null;
}

/** `GET /api/license/health` — org-admin only, 403 otherwise. */
export interface LicenseHealth {
    refresher: { enabled: boolean; lastTickAt?: string | null; lastError?: string | null };
    crl: { enabled: boolean; lastPollAt?: string | null };
    dunning: { past_due_count: number; suspended_count: number };
    now: string;
}

/** `GET /api/subscriptions/consumer/usage`. */
export interface ConsumerUsage {
    limits: {
        max_messages_per_month: number | null;
        max_tokens_per_month: number | null;
        max_cost_per_month: number | null;
        max_agents: number | null;
        max_knowledge_sources: number | null;
        allowed_features: string[];
        allowed_models: string[];
        plan_name: string;
    };
    usage: {
        total_billed_cost: number;
        by_type: { agent_type?: string; billed_cost?: Numeric }[];
    };
    billing_period: { start: string; end: string };
    /** 'fixed' hides every €-per-token figure — the plan is flat-rate. */
    billing_model: string;
    subscription: {
        status: string;
        plan_name?: string;
        payment_status?: string;
        trial_end_date?: string | null;
        billing_model?: string;
    } | null;
}

// ── Usage (server/routes/usage.js + stores/usageStore.js) ──

/** `GET /api/usage/summary`. Members see only their own rows; the router
 *  scopes `userId` server-side for consumer accounts. */
export interface UsageSummary {
    total_calls: Numeric;
    total_tokens: Numeric;
    total_prompt_tokens: Numeric;
    total_completion_tokens: Numeric;
    total_cached_tokens?: Numeric;
    total_estimated_cost: Numeric;
    total_input_cost?: number;
    total_output_cost?: number;
    azure_services_total_cost?: number;
    combined_total_cost?: number;
    unique_models?: Numeric;
    unique_users?: Numeric;
    avg_duration_ms?: Numeric;
}

/** `GET /api/usage/cost-timeline?days=&interval=day`. */
export interface CostPoint {
    /** 'YYYY-MM-DD', or 'YYYY-MM-DD HH:00' when interval=hour. */
    period: string;
    calls: Numeric;
    total_cost: Numeric;
    total_billed_cost?: Numeric;
    prompt_tokens: Numeric;
    completion_tokens: Numeric;
}

/** `GET /api/usage/by-model?days=`. */
export interface ModelUsage {
    model: string;
    calls: Numeric;
    total_tokens: Numeric;
    prompt_tokens: Numeric;
    completion_tokens: Numeric;
    estimated_cost: Numeric;
    input_cost?: number;
    output_cost?: number;
}

// ── Privacy shield (server/routes/orgPrivacyShield.js) ──

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

// ── Organisation (server/auth/admin/orgRoutes.js, userRoutes.js) ──

/** `GET /auth/organizations` (a list) and `/auth/organizations/:id`. */
export interface Organization {
    id: string;
    name: string;
    description?: string;
    tagline?: string;
    email?: string;
    phone?: string;
    website?: string;
    address?: string;
    kvk?: string;
    vat?: string;
    logo?: string | null;
    allowSignup?: boolean;
}

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

// ── Compliance / DSR (server/routes/dsr.js) ──

export interface DsrRequest {
    id: number;
    status: string;
    request_type: string;
    subject_email?: string;
    created_at: string;
    fulfilled_at?: string | null;
    notes?: string;
}

/** `POST /api/dsr/requests` — public, rate-limited to 5/hour per IP. */
export interface DsrSubmitResponse {
    id: number;
    created_at: string;
    status_url: string;
    ack: string;
}

// ── Integrations ──

/**
 * The union of what the per-provider `/status` endpoints return. They do NOT
 * share a shape: Google and Microsoft report `configured` (has the admin set
 * client credentials?) and `needsReauth`; LinkedIn reports only
 * `connected` + `name`; GitHub reports `connected` + `login`.
 */
export interface IntegrationStatus {
    connected: boolean;
    configured?: boolean;
    needsReauth?: boolean;
    email?: string | null;
    name?: string | null;
    /** GitHub returns the account handle under `username`, not `login`. */
    username?: string | null;
}

/** `GET /api/integrations/<provider>/auth-url`. */
export interface AuthUrlResponse {
    url: string;
}

/** One row of the app-level integration catalogue, mirrored from
 *  agent-hub/src/config/integrationCatalog.js. */
export interface CatalogEntry {
    id: string;
    label: string;
    description: string;
    category: string;
}

/** `GET /ai/user-settings` — the "which apps may the model call" surface, plus
 *  a pile of per-provider "is a key stored" booleans. */
export interface UserSettings {
    /** null means "no explicit list" → everything the org allows. */
    enabledApps: string[] | null;
    /** null means the org places no restriction. */
    orgEnabledIntegrations: string[] | null;
    isGoogleUser: boolean;
    isMicrosoftUser: boolean;
    hasFirefliesKey: boolean;
    hasYouTrackConfig: boolean;
    hasGammaKey: boolean;
    hasSignRequestConfig: boolean;
    hasAfasConfig: boolean;
    hasNmbrsConfig: boolean;
    hasVplanConfig: boolean;
    hasLinkedInConfig: boolean;
    hasWithingsConfig: boolean;
    hasN8nConfig: boolean;
    simpleMode: boolean;
    userEuModeEnabled: boolean;
    orgEuModeForced: boolean;
    hasEuModelsConfigured: boolean;
    disableSearchOnUpload: boolean;
}

/** `GET /api/integrations/connections` — named credentials, secrets never
 *  returned (only presence and metadata). */
export interface IntegrationConnection {
    id: string;
    provider: string;
    kind: string;
    label?: string;
    createdAt?: string;
    lastUsedAt?: string | null;
    secretMeta?: Record<string, string>;
}

// ── Admin ──

/** `GET /api/admin/modules` — super-admin only. */
export interface PlatformModule {
    moduleId?: string;
    id?: string;
    name?: string;
    version?: string | null;
    status?: string;
    enabled?: boolean;
    running?: boolean;
    source?: string | null;
}

/** `GET /api/admin/modules/health` — super-admin only. */
export interface ModuleHealth {
    hub?: { connected?: boolean; url?: string | null };
    modules: {
        moduleId: string;
        ledgerStatus: string | null;
        version: string | null;
        running: boolean;
        pendingRestart: boolean;
        lastActivationError: string | null;
        crashesInWindow: number;
        restartAdvised: boolean;
    }[];
}

/** `GET /api/maintenance` — what the deploy pipeline announced, if anything. */
export interface MaintenanceState {
    maintenance: {
        active?: boolean;
        reason?: string | null;
        etaSeconds?: number | null;
        startedAt?: string | null;
        ref?: string | null;
    } | null;
    /** The build sha the server is actually running. */
    appVersion: string;
}

/** `GET /api/admin/guard/…` is a different router; this is `/api/guard/health`,
 *  a top-level route in server/index.js. */
export interface GuardHealth {
    status: string;
}

// ── Release notes + support ──

/** `GET /api/release-notes/public` — published entries only. */
export interface ReleaseNote {
    id: string;
    version: string | null;
    title: string;
    lead: string;
    items: string[];
    publishedAt: string;
}

/**
 * `GET /api/support/threads/mine`. Columns come straight off the
 * `support_threads` table (server/stores/supportStore.js), so they are
 * snake_case and `status` is one of the six CHECK-constrained values:
 * open | ai_responding | awaiting_user | awaiting_agent | resolved | closed.
 */
export interface SupportThread {
    id: string;
    subject: string;
    status: string;
    priority?: string;
    created_at: string;
    updated_at?: string;
    last_message_at?: string | null;
    ai_handled?: boolean;
    resolved_at?: string | null;
}

/** A row of `support_messages`. `author_kind` distinguishes the AI responder
 *  from a human agent — worth showing, since the first reply is usually AI. */
export interface SupportMessage {
    id: string;
    body: string;
    author_kind: string;
    author_display?: string | null;
    created_at: string;
}

/** `GET /api/support/threads/:id`. */
export interface SupportThreadDetail {
    thread: SupportThread;
    messages: SupportMessage[];
    viewerIsStaff: boolean;
}

// ── Language ──

/** `GET /api/languages/user/locales`. */
export interface Locale {
    code: string;
    name: string;
    isOrgDefault?: boolean;
    enabled?: boolean;
}
