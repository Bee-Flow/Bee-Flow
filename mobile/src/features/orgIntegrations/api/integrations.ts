/**
 * The organisation's integration settings: the Google Maps key, the
 * Nextcloud tool switches, and the org-wide beta switches that make a system
 * knowledge base usable.
 *
 * Verified against:
 * - server/routes/ai/config/instanceConfig.js — GET /ai/config (any member;
 *   `hasGoogleMapsKey`), POST /ai/config `{ googleMapsApiKey }` (a closed
 *   body; `admin_ai_config`, which org_admin holds).
 * - server/routes/admin/ncIntegrations.js — GET/PUT
 *   /auth/admin/:orgId/nc-integrations `{ enabled }` and GET …/groups, PUT
 *   …/groups/:groupId `{ disabledIntegrations }` (.strict(); NC ids only;
 *   requireOrgAdmin and an NC-bound org, else 400).
 * - server/auth/admin/featureAccessRoutes.js — GET/PUT /auth/me/active-features
 *   `{ betaEnabled }` (.strict(); org_admin; ignored when the subscription
 *   governs the betas), GET /auth/beta-features (requireAdmin) and PUT
 *   /auth/organizations/:orgId/beta-features `{ features }` (the super-admin
 *   allow-list; 409 when governed).
 */

import { api } from '@/core/api/client';

import {
    readActiveFeatures,
    readBetaAllowList,
    readHasMapsKey,
    readNcIntegrationGroups,
    readNcIntegrations,
} from './integrationReaders';
import type { ActiveFeatures, NcIntegrationGroup, NcIntegrations } from '../model/types';

const seg = encodeURIComponent;
const ncPath = (orgId: string) => `/auth/admin/${seg(orgId)}/nc-integrations`;

export async function getHasMapsKey(signal?: AbortSignal): Promise<boolean> {
    return readHasMapsKey(await api.get<unknown>('/ai/config', { signal }));
}

export async function saveMapsKey(googleMapsApiKey: string): Promise<void> {
    await api.post('/ai/config', { googleMapsApiKey });
}

export async function getNcIntegrations(orgId: string, signal?: AbortSignal): Promise<NcIntegrations> {
    return readNcIntegrations(await api.get<unknown>(ncPath(orgId), { signal }));
}

export async function saveNcIntegrations(orgId: string, enabled: string[]): Promise<void> {
    await api.put(ncPath(orgId), { enabled });
}

export async function getNcIntegrationGroups(orgId: string, signal?: AbortSignal): Promise<NcIntegrationGroup[]> {
    return readNcIntegrationGroups(await api.get<unknown>(`${ncPath(orgId)}/groups`, { signal }));
}

export async function saveNcGroupDisabled(orgId: string, groupId: string, disabledIntegrations: string[]): Promise<void> {
    await api.put(`${ncPath(orgId)}/groups/${seg(groupId)}`, { disabledIntegrations });
}

export async function getActiveFeatures(signal?: AbortSignal): Promise<ActiveFeatures> {
    return readActiveFeatures(await api.get<unknown>('/auth/me/active-features', { signal }));
}

export async function setActiveBetaFeatures(betaEnabled: string[]): Promise<void> {
    await api.put('/auth/me/active-features', { betaEnabled });
}

export async function getBetaAllowList(orgId: string): Promise<string[]> {
    return readBetaAllowList(await api.get<unknown>('/auth/beta-features'), orgId);
}

export async function setBetaAllowList(orgId: string, features: string[]): Promise<void> {
    await api.put(`/auth/organizations/${seg(orgId)}/beta-features`, { features });
}
