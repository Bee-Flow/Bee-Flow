/**
 * The organisation's Privacy Shield as this feature edits it.
 *
 * Written from server/routes/orgPrivacyShield.js (the GET default document,
 * the PUT schema ORG_SHAPE and the rebuild in the PUT handler) and from the
 * web's useOrgShield.js, whose `normaliseDoc`/`buildPayload` this ports.
 */

export type DlpMode = 'ask' | 'auto_redact' | 'block';
export type FailureMode = 'fail_closed' | 'fail_open';
export type ToolClass = 'external' | 'internal';

/** One of the org's own "always hide" terms. Extra keys (createdAt, createdBy)
 *  ride along so a save does not restamp them. */
export interface CustomTerm {
    id: string;
    label: string;
    pattern: string;
    type: 'literal' | 'regex';
    caseSensitive: boolean;
    [extra: string]: unknown;
}

export interface ToolPiiPolicy {
    external: { blockCategories: string[] };
    internal: { blockCategories: string[] };
}

/** The values the editor changes — the web's `normaliseDoc` output. */
export interface ShieldFields {
    enabled: boolean;
    euModeEnabled: boolean;
    webSearchGuard: boolean;
    disableSearchOnUpload: boolean;
    monitorIntegrations: boolean;
    applyToAutomations: boolean;
    dlpEnabled: boolean;
    dlpMode: DlpMode;
    dlpAlwaysReview: boolean;
    customSensitiveTerms: CustomTerm[];
    piiAllowTerms: string[];
    piiAllowPublicOrgs: boolean;
    toolPiiPolicy: ToolPiiPolicy;
    piiCategories: string[];
    piiConfidenceThreshold: number;
    /** 'block' | 'tokenize' (the server also knows 'warn'). */
    piiAction: string;
    piiFailureMode: FailureMode;
    scanKnowledgeBases: boolean;
    showRawPayload: boolean;
}

/** `stalenessWarnings[]` from core/privacy/orgShield.js resolveOrgShield. */
export interface StalenessWarning {
    collectionId: string;
    ruleId?: string;
    /** 'collection_not_found' | 'rule_not_found' | 'collection_empty'. */
    reason: string;
}

/** `GET /api/org-privacy-shield/:orgId`, with the raw document kept: the PUT
 *  replaces the row, so every key this build does not edit travels back. */
export interface ShieldDoc {
    raw: Record<string, unknown>;
    clampedFields: string[];
    clampedTier: string | null;
    stalenessWarnings: StalenessWarning[];
    updatedAt: string | null;
    updatedBy: string | null;
}

/** `PUT /api/org-privacy-shield/:orgId` → `{ ok, config, termErrors, clamped_fields?, clamped_tier? }`. */
export interface ShieldSaveResult {
    config: Record<string, unknown> | null;
    termErrors: { id: string | null; label: string; error: string }[];
    clampedFields: string[];
    clampedTier: string | null;
}

/** `GET /api/org-privacy-shield/user/guard-status`. */
export interface GuardStatus {
    configured: boolean;
    reachable: boolean;
}

/** Which cards are relevant at all: `/ai/config` and `/ai/config/chat-models-eu`. */
export interface ShieldEnv {
    hasWebSearchEnabled: boolean;
    hasEuModelsConfigured: boolean;
}
