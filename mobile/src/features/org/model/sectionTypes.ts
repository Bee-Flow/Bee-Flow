/**
 * The org-admin settings sections' payloads, as their route handlers send
 * them. Each names the server file it was read from.
 */

/** `GET /api/languages/org/default` (routes/admin/languageRoutes.js). */
export interface OrgLanguages {
    defaultLocale: string;
    locales: { code: string; name: string }[];
}

/** One row of `tierOptions` (stores/encryptionAvailability.js). */
export interface EncryptionTierOption {
    tier: string;
    selectable: boolean;
    /** Why it cannot be chosen, in the server's words. */
    reason: string | null;
    warningReason: string | null;
    /** 'entitlement' (a plan answer) or 'readiness' (a configuration answer). */
    blockedBy: string | null;
}

/** `GET /auth/organizations/:id/encryption` (auth/admin/orgRoutes.js). */
export interface OrgEncryption {
    tier: string;
    entitled: boolean;
    tierOptions: EncryptionTierOption[];
}

/** `PUT …/encryption` answers the new tier and whether everyone was signed out. */
export interface EncryptionSaveResult {
    tier: string;
    sessionsBusted: boolean;
}

/** `GET|PUT /api/org-ai-context/:orgId` (routes/orgAiContext.js, core/llm/contextPolicy.js). */
export interface OrgAiContext {
    compactionEnabled: boolean;
    compactionThreshold: number;
    recentWindow: number;
    contextBudgetPercent: number;
    contextWindowExamples: { label: string; contextWindow: number }[];
    contextBudgetRange: { min: number; max: number };
}

/** The PUT body: `compactionEnabled` is required, the tunables are clamped server-side. */
export interface AiContextBody {
    compactionEnabled: boolean;
    compactionThreshold: number;
    recentWindow: number;
    contextBudgetPercent: number;
}

/** `GET|PUT /api/org-integration-cache/:orgId` (routes/orgIntegrationCache.js). */
export interface OrgIntegrationCache {
    enabled: boolean;
    ttlSeconds: number;
    scopes: { integration: boolean; http: boolean };
    killSwitch: boolean;
    ttlRange: { min: number; max: number };
    entries: number;
    expiredEntries: number;
    bytes: number;
    /** On a PUT that switched it off: how many stored answers went. */
    purged: number;
}

export interface IntegrationCacheBody {
    enabled: boolean;
    ttlSeconds: number;
    scopes: { integration: boolean; http: boolean };
}

/** A member row of `GET /ai/learning/org-overview` (learning/orgOverview.js). */
export interface AcademyMember {
    userId: string;
    displayName: string;
    email: string | null;
    avatar: string | null;
    avatarType: string | null;
    coursesDone: string[];
    badges: string[];
    certificates: { certificateId: string; level: string | null; issuedAt: string | null }[];
    lastActivity: string | null;
}

export interface AcademyOverview {
    courses: { id: string; title: string; lessonCount: number }[];
    totals: {
        members: number | null;
        coursesCompleted: number | null;
        certificatesIssued: number | null;
        activeLast30d: number | null;
    };
    members: AcademyMember[];
}
