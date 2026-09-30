/**
 * The organisation's processing policies: content encryption, conversation
 * memory and answer reuse. All three answer a member's GET and refuse a
 * non-admin's PUT with 403; the screens only ask as an org admin.
 *
 * Verified against:
 * - server/auth/admin/orgRoutes.js — GET/PUT /auth/organizations/:id/encryption,
 *   body `{ tier?, scope? }` (.strict(); `scope` is super-admin only, so it is
 *   never sent here), answer `{ tier, sessionsBusted, … }`; a locked tier is a
 *   403 (entitlement) or 409 (readiness).
 * - server/routes/orgAiContext.js — GET/PUT /api/org-ai-context/:orgId, body
 *   `{ compactionEnabled (required), compactionThreshold?, recentWindow?,
 *   contextBudgetPercent? }` (.strict(); numbers clamped by contextPolicy.js).
 *   The PUT is a full replace, so every tunable travels back as read.
 * - server/routes/orgIntegrationCache.js — GET/PUT /api/org-integration-cache/:orgId,
 *   body `{ enabled (required), ttlSeconds?, scopes?: { integration?, http? } }`
 *   (.strict()), and DELETE …/entries with no body → `{ purged }`.
 */

import { api } from '@/core/api/client';

import {
    readEncryptionSave,
    readOrgAiContext,
    readOrgEncryption,
    readOrgIntegrationCache,
} from './sectionReaders';
import type {
    AiContextBody,
    EncryptionSaveResult,
    IntegrationCacheBody,
    OrgAiContext,
    OrgEncryption,
    OrgIntegrationCache,
} from '../model/sectionTypes';

const id = encodeURIComponent;

export async function getOrgEncryption(orgId: string, signal?: AbortSignal): Promise<OrgEncryption | null> {
    return readOrgEncryption(await api.get<unknown>(`/auth/organizations/${id(orgId)}/encryption`, { signal }));
}

export async function saveOrgEncryption(orgId: string, tier: string): Promise<EncryptionSaveResult> {
    return readEncryptionSave(await api.put<unknown>(`/auth/organizations/${id(orgId)}/encryption`, { tier }));
}

export async function getOrgAiContext(orgId: string, signal?: AbortSignal): Promise<OrgAiContext | null> {
    return readOrgAiContext(await api.get<unknown>(`/api/org-ai-context/${id(orgId)}`, { signal }));
}

export async function saveOrgAiContext(orgId: string, body: AiContextBody): Promise<OrgAiContext | null> {
    return readOrgAiContext(await api.put<unknown>(`/api/org-ai-context/${id(orgId)}`, body));
}

export async function getOrgIntegrationCache(
    orgId: string,
    signal?: AbortSignal,
): Promise<OrgIntegrationCache | null> {
    return readOrgIntegrationCache(await api.get<unknown>(`/api/org-integration-cache/${id(orgId)}`, { signal }));
}

export async function saveOrgIntegrationCache(
    orgId: string,
    body: IntegrationCacheBody,
): Promise<OrgIntegrationCache | null> {
    return readOrgIntegrationCache(await api.put<unknown>(`/api/org-integration-cache/${id(orgId)}`, body));
}

/** Forget every stored answer now. Answers how many went. */
export async function purgeOrgIntegrationCache(orgId: string): Promise<number> {
    const raw = await api.delete<unknown>(`/api/org-integration-cache/${id(orgId)}/entries`);
    return readOrgIntegrationCache(raw)?.purged ?? 0;
}
