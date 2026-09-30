/** Integration shapes: per-provider status, the catalogue, and the model's allow-list. */

/**
 * The union of what the per-provider `/status` endpoints return. They do NOT
 * share a shape: Google and Microsoft report `configured` (has the admin set
 * client credentials?) and `needsReauth`; LinkedIn reports only
 * `connected` + `name`; GitHub reports `connected` + `username`.
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
