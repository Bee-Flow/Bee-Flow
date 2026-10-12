/**
 * The Azure configuration, as server/routes/orgAzureConfig.js serialises it.
 * Every key it saves is the INSTALLATION's (the same ones the admin dashboard
 * writes), which is why the route opens to org admins on self-hosted only.
 */

/** One chat tier. The object stays open on the server: `raw` keeps what the phone does not edit. */
export interface AzureTier {
    modelId: string;
    label: string;
    maxTokens: number | null;
    temperature: number | null;
    reasoningEffort: string | null;
    reasoningSummary: boolean;
    raw: Record<string, unknown>;
}

export interface AzureGroupSyncSettings {
    destructiveSync: boolean;
    autoActivateUsers: boolean;
    periodicSync: boolean;
    syncIntervalHours: number;
}

export interface AzureGroupSyncStatus {
    lastSyncAt: string | null;
    /** 'success' | 'partial' | 'error', or null before the first run. */
    lastSyncResult: string | null;
    syncedGroups: number;
    syncedUsers: number;
}

/** `GET /api/org-azure-config/:orgId`. Secrets arrive as `has…` flags only. */
export interface AzureConfig {
    azureEndpoint: string;
    hasAzureApiKey: boolean;
    /** Comma-separated deployment names; also the chat-tier model list. */
    azureModels: string;
    chatModelTiers: Record<string, AzureTier>;
    useAzureDocProcessing: boolean;
    azureDocEndpoint: string;
    hasAzureDocEndpoint: boolean;
    hasAzureDocKey: boolean;
    azureEmbedEndpoint: string;
    hasAzureEmbedEndpoint: boolean;
    hasAzureEmbedKey: boolean;
    azureEmbedModel: string;
    ssoClientId: string;
    hasSsoClientSecret: boolean;
    ssoTenantId: string;
    autoApproveSSO: boolean;
    groupSyncSettings: AzureGroupSyncSettings;
    groupSyncStatus: AzureGroupSyncStatus;
}

/** `POST …/sync-groups` (integrations/azureGroupSync.js syncAzureGroupsToOrg). */
export interface AzureSyncResult {
    ok: boolean;
    groups: number;
    users: number;
    /** What went wrong, per group or user; on `ok: false` the one error that stopped the run. */
    errors: string[];
    /** The run's log, line by line. */
    details: string[];
}

/** The four sections of the web panel (constants.js SUB_SECTIONS), each its own screen here. */
export type AzureSectionId = 'openai' | 'chatModels' | 'docProcessing' | 'sso';
