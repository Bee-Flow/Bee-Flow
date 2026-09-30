/**
 * The organisation's n8n connection: credentials, test, discovered and
 * configured workflows, the access check, and who may let the AI modify
 * workflows.
 *
 * Verified against server/routes/ai/config/integrations.js:
 * - GET /ai/n8n/config (any member) → `{ configured, n8nUrl, hasApiKey, workflows }`;
 * - PUT /ai/n8n/config and POST /ai/n8n/test, both `{ n8nUrl?, apiKey? }`
 *   (a closed body); the test answers `{ ok, activeWebhookCount | status, error }`
 *   with 200 even when n8n refused;
 * - GET /ai/n8n/workflows → `{ workflows }` (400 until configured);
 *   PUT /ai/n8n/workflows `{ workflows: object[] }` stores the list as sent;
 * - GET /ai/n8n/diagnostics (the caller's own gates) and POST
 *   /ai/n8n/enable-for-org (no body) → `{ changed, note? }`;
 * - GET /ai/n8n/permissions, PUT /ai/n8n/permissions `{ permission, groupId,
 *   action: 'add' | 'remove' }`.
 * Every write is requireOrgAdminForN8n: a super admin, or orgRole
 * admin/org_admin in the home organisation.
 *
 * "Create & grant" posts a new group WITH the permission to /auth/groups
 * (auth/admin/groupRoleRoutes.js CreateGroupBody takes `permissions`), one
 * call as on the web: orgPeople's createGroup sends no permissions, and a
 * create-then-grant pair would leave an ungranted group behind on a failure.
 */

import { api } from '@/core/api/client';

import { readDiscovered, readN8nConfig, readN8nDiagnostics, readN8nPermissions, readN8nTest } from './n8nReaders';
import type {
    DiscoveredWorkflow,
    N8nConfig,
    N8nDiagnostics,
    N8nPermissions,
    N8nTestResult,
} from '../model/n8nTypes';

export interface N8nCredentials {
    n8nUrl?: string;
    /** Only a newly typed key; the stored one is kept when this is absent. */
    apiKey?: string;
}

export async function getN8nConfig(signal?: AbortSignal): Promise<N8nConfig> {
    return readN8nConfig(await api.get<unknown>('/ai/n8n/config', { signal }));
}

export async function saveN8nConfig(body: N8nCredentials): Promise<void> {
    await api.put('/ai/n8n/config', body);
}

export async function testN8n(body: N8nCredentials): Promise<N8nTestResult> {
    return readN8nTest(await api.post<unknown>('/ai/n8n/test', body));
}

export async function discoverN8nWorkflows(): Promise<DiscoveredWorkflow[]> {
    return readDiscovered(await api.get<unknown>('/ai/n8n/workflows'));
}

export async function saveN8nWorkflows(workflows: Record<string, unknown>[]): Promise<void> {
    await api.put('/ai/n8n/workflows', { workflows });
}

export async function getN8nDiagnostics(signal?: AbortSignal): Promise<N8nDiagnostics> {
    return readN8nDiagnostics(await api.get<unknown>('/ai/n8n/diagnostics', { signal }));
}

export async function enableN8nForOrg(): Promise<void> {
    await api.post('/ai/n8n/enable-for-org');
}

export async function getN8nPermissions(signal?: AbortSignal): Promise<N8nPermissions> {
    return readN8nPermissions(await api.get<unknown>('/ai/n8n/permissions', { signal }));
}

export async function setN8nPermission(body: { permission: string; groupId: string; action: 'add' | 'remove' }): Promise<void> {
    await api.put('/ai/n8n/permissions', body);
}

export async function createGroupWithPermission(name: string, permission: string): Promise<void> {
    await api.post('/auth/groups', { name, permissions: [permission] });
}
