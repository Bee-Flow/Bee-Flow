/**
 * The org Privacy Shield's server calls. Verified against:
 *   - server/routes/orgPrivacyShield.js — GET /:orgId (members; clamped
 *     response), PUT /:orgId (org admin; body = the whole document, see
 *     ORG_SHAPE + refuseStrangers; REPLACES the row), GET /user/guard-status;
 *   - server/routes/ai/config/instanceConfig.js (GET /ai/config) and
 *     modelTiers.js (GET /ai/config/chat-models-eu), which decide whether the
 *     web-search and EU-model cards are relevant at all;
 *   - server/routes/usage.js — GET /api/usage/guardrails/{overview,recent} and
 *     /integrations/{overview,egress}: UsageQuery (days, interval, limit),
 *     org-admin only (usageMonitoringAuth.js), org from the session.
 */

import { api } from '@/core/api/client';
import { optional } from '@/core/api/optional';

import {
    readEgress,
    readGuardEvents,
    readGuardOverview,
    readGuardStatus,
    readIntegrationOverview,
    readSaveResult,
    readShieldDoc,
    readShieldEnv,
} from './readers';
import type { ShieldActivity } from '../model/activityTypes';
import type { GuardStatus, ShieldDoc, ShieldEnv, ShieldSaveResult } from '../model/types';

const shieldPath = (orgId: string) => `/api/org-privacy-shield/${encodeURIComponent(orgId)}`;

export async function getShieldDoc(orgId: string, signal?: AbortSignal): Promise<ShieldDoc | null> {
    return readShieldDoc(await api.get<unknown>(shieldPath(orgId), { signal }));
}

/** A write: no retry. `body` is `buildPayload(loaded document, fields)`. */
export async function saveShieldDoc(orgId: string, body: Record<string, unknown>): Promise<ShieldSaveResult> {
    return readSaveResult(await api.put<unknown>(shieldPath(orgId), body));
}

export async function getGuardStatus(signal?: AbortSignal): Promise<GuardStatus | null> {
    return readGuardStatus(await api.get<unknown>('/api/org-privacy-shield/user/guard-status', { signal }));
}

/** Both reads are advisory: a refusal means "not relevant", never an error. */
export async function getShieldEnv(signal?: AbortSignal): Promise<ShieldEnv> {
    const [config, eu] = await Promise.all([
        optional(() => api.get<unknown>('/ai/config', { signal })),
        optional(() => api.get<unknown>('/ai/config/chat-models-eu', { signal })),
    ]);
    return readShieldEnv(config, eu);
}

/** The window the web's Activity tab offers (7, 30 or 90 days); detail rows cap at 200. */
export async function getShieldActivity(days: number, signal?: AbortSignal): Promise<ShieldActivity> {
    const query = { days, interval: 'day' };
    const detail = { ...query, limit: 200 };
    const [guard, integrations, events, egress] = await Promise.all([
        optional(() => api.get<unknown>('/api/usage/guardrails/overview', { signal, query })),
        optional(() => api.get<unknown>('/api/usage/integrations/overview', { signal, query })),
        optional(() => api.get<unknown>('/api/usage/guardrails/recent', { signal, query: detail })),
        optional(() => api.get<unknown>('/api/usage/integrations/egress', { signal, query: detail })),
    ]);
    return {
        guard: readGuardOverview(guard),
        integrations: readIntegrationOverview(integrations),
        events: readGuardEvents(events),
        egress: readEgress(egress),
    };
}
