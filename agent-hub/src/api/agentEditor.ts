// The requests the agent editor (AgentWizard/BuilderSplit) sends itself.
//
// Each helper sends exactly the request the editor used to send inline and
// hands the Response back untouched: the callers keep reading `res.ok`, the
// status and the body as before. The one exception is `agentUsageFetcher`,
// which is a `useUsage` fetcher and therefore throws on a non-2xx answer.

import { API_BASE, authFetch } from '../utils/helpers';
import { logger } from '../utils/logger';

type Id = string | number;

/** GET /agents/:id — the full agent, used by a version restore and "Load latest". */
export function fetchAgent(agentId: Id): Promise<Response> {
    return authFetch(`${API_BASE}/agents/${agentId}`);
}

/** POST /agents — the explicit first save of a draft. */
export function createAgent(payload: Record<string, unknown>): Promise<Response> {
    return authFetch(`${API_BASE}/agents`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
    });
}

/** POST /agents/:id/publish-version — which config and prompt the runtime serves. */
export function publishAgentVersion(agentId: Id): Promise<Response> {
    return authFetch(`${API_BASE}/agents/${agentId}/publish-version`, { method: 'POST' });
}

/** POST /versions/:agentId/:versionId/restore — restore one stored version. */
export function restoreAgentVersion(agentId: Id, versionId: Id): Promise<Response> {
    return authFetch(`${API_BASE}/versions/${agentId}/${versionId}/restore`, { method: 'POST' });
}

/** GET /api/cowork — the user's Cowork list; the editor keeps the items of one agent. */
export function fetchCoworkSchedules(): Promise<Response> {
    return authFetch(`${API_BASE}/api/cowork`);
}

/**
 * The six reads a standalone editor needs for its pickers, sent together:
 * skills, integration status, categories, org groups, tiers and automations.
 * A failed automations request resolves as `{ ok: false }` (the module may be
 * off); any other rejection rejects the whole read.
 */
export function fetchAgentEditorBootstrap(): Promise<[Response, Response, Response, Response, Response, Response | { ok: false }]> {
    return Promise.all([
        authFetch(`${API_BASE}/api/skills`),
        authFetch(`${API_BASE}/ai/user-settings`),
        authFetch(`${API_BASE}/agents/categories`),
        authFetch(`${API_BASE}/auth/groups`),
        authFetch(`${API_BASE}/ai/config/tiers-for-user?taskType=direct_chat`),
        authFetch(`${API_BASE}/automation`).catch(() => ({ ok: false as const })),
    ]);
}

interface UsageRequestError extends Error {
    status?: number;
    code?: string | null;
}

/**
 * The `useUsage` fetcher for an agent: GET /agents/:id/usage.
 *
 * useUsage's own URL table points at /api/agents/:id/usage, and that mount
 * does not exist: the agents router is mounted on /agents (server/index.js).
 * Without this fetcher every read would be a 404 and the "Used by" tab would
 * stay "not read" forever.
 */
export async function agentUsageFetcher(_kind: string, id: Id | null | undefined): Promise<unknown> {
    const res: Response = await authFetch(`${API_BASE}/agents/${encodeURIComponent(String(id))}/usage`);
    let body: { error?: string; code?: string } | null = null;
    try { body = await res.json(); } catch (err) { logger.debug('empty or not JSON', err); }
    if (!res.ok) {
        const err: UsageRequestError = new Error(body?.error || `Request failed (${res.status})`);
        err.status = res.status;
        err.code = body?.code || null;
        throw err;
    }
    return body;
}
