/**
 * The Azure configuration (self-hosted only).
 *
 * Verified against server/routes/orgAzureConfig.js, mounted at
 * /api/org-azure-config: GET /:orgId and PUT /:orgId behind
 * platformConfigGate (self-hosted, or a platform admin) and the STRICT org
 * admin check (orgRole org_admin; the legacy 'admin' is refused). The PUT is a
 * discriminated union on `section` — openai, chatModels, piiDetection,
 * docProcessing, sso — each `.strict()`; an empty or absent secret keeps the
 * stored one, and `chatModelTiers` is merged over the stored map. Group sync:
 * POST /:orgId/sync-groups (no body) and PUT /:orgId/sync-groups/settings
 * `{ destructiveSync?, autoActivateUsers?, periodicSync?, syncIntervalHours? }`
 * (booleans, and whole hours 1–168) → `{ ok, settings }`.
 */

import { api } from '@/core/api/client';
import { pick } from '@/core/api/contract';

import { readAzureConfig, readAzureSyncResult, readAzureSyncSettings } from './azureReaders';
import type { AzureConfig, AzureGroupSyncSettings, AzureSyncResult } from '../model/azureTypes';

const seg = encodeURIComponent;
const path = (orgId: string) => `/api/org-azure-config/${seg(orgId)}`;

/** One section's save; the body carries `section` and that section's keys only. */
export type AzureSectionBody =
    | { section: 'openai'; azureEndpoint: string; azureApiKey?: string; azureApiVersion: string; azureModels: string }
    | { section: 'chatModels'; chatModelTiers: Record<string, Record<string, unknown>> }
    | {
          section: 'docProcessing';
          useAzureDocProcessing: boolean;
          azureDocIntelligenceEndpoint?: string;
          azureDocIntelligenceKey?: string;
          azureOpenaiEmbeddingEndpoint?: string;
          azureOpenaiEmbeddingKey?: string;
          azureOpenaiEmbeddingModel: string;
      }
    | { section: 'sso'; ssoClientId: string; ssoClientSecret?: string; ssoTenantId: string; autoApproveSSO: boolean };

export async function getAzureConfig(orgId: string, signal?: AbortSignal): Promise<AzureConfig> {
    return readAzureConfig(await api.get<unknown>(path(orgId), { signal }));
}

export async function saveAzureSection(orgId: string, body: AzureSectionBody): Promise<void> {
    await api.put(path(orgId), body);
}

export async function syncAzureGroups(orgId: string): Promise<AzureSyncResult> {
    return readAzureSyncResult(await api.post<unknown>(`${path(orgId)}/sync-groups`));
}

export async function saveAzureSyncSettings(
    orgId: string,
    patch: Partial<AzureGroupSyncSettings>,
): Promise<AzureGroupSyncSettings> {
    return readAzureSyncSettings(pick(await api.put<unknown>(`${path(orgId)}/sync-groups/settings`, patch), 'settings'));
}
