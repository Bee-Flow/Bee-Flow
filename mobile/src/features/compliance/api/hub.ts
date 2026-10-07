/**
 * The hub's shared server calls, each answer read through hubReaders.ts.
 * Mounted at /api/compliance (server/routes/compliance/{counts,attention,
 * deadlines,checks,evidence,frameworks}.js). Keys live under
 * ['compliance', 'hub', …] so they never collide with api/keys.ts.
 */

import { api } from '@/core/api/client';

import {
    readAttentionList,
    readAutoFixResult,
    readCheckHistoryRows,
    readCheckRows,
    readDeadlineList,
    readEvidenceRows,
    readFrameworkList,
    readHubCounts,
    readRunResult,
    type AutoFixResult,
} from './hubReaders';
import { COMPLIANCE, seg } from '../model/paths';

const get = (path: string, signal?: AbortSignal, query?: Record<string, string | number | undefined>) =>
    api.get<unknown>(path, { signal, query });

export const hubKeys = {
    all: ['compliance', 'hub'] as const,
    counts: () => ['compliance', 'hub', 'counts'] as const,
    attention: () => ['compliance', 'hub', 'attention'] as const,
    deadlines: () => ['compliance', 'hub', 'deadlines'] as const,
    frameworks: () => ['compliance', 'hub', 'frameworks'] as const,
    checks: (framework: string | null) => ['compliance', 'hub', 'checks', framework ?? 'all'] as const,
    checkHistory: (checkId: string, scopeId: string | null) => ['compliance', 'hub', 'check-history', checkId, scopeId ?? 'all'] as const,
    checkEvidence: (checkId: string) => ['compliance', 'hub', 'check-evidence', checkId] as const,
};

/** The most the server returns in one page (compliance/attention.js: 0-50). */
export const ATTENTION_LIMIT = 50;

export const getCounts = async (signal?: AbortSignal) => readHubCounts(await get(`${COMPLIANCE}/counts`, signal));
export const getAttention = async (signal?: AbortSignal) =>
    readAttentionList(await get(`${COMPLIANCE}/attention`, signal, { limit: ATTENTION_LIMIT }));
export const getDeadlines = async (signal?: AbortSignal) => readDeadlineList(await get(`${COMPLIANCE}/deadlines`, signal));
export const getFrameworks = async (signal?: AbortSignal) => readFrameworkList(await get(`${COMPLIANCE}/frameworks`, signal));

/** GET /checks[?framework=<id>] — every check of the org's active frameworks. */
export async function getChecks(framework: string | null, signal?: AbortSignal) {
    return readCheckRows(await get(`${COMPLIANCE}/checks`, signal, framework ? { framework } : undefined));
}

/** GET /checks/:id/history[?scope_id=] — one subject's trail, or the whole check's. */
export async function getCheckHistory(checkId: string, scopeId: string | null, signal?: AbortSignal) {
    return readCheckHistoryRows(await get(`${COMPLIANCE}/checks/${seg(checkId)}/history`, signal, scopeId ? { scope_id: scopeId } : undefined));
}

export const getCheckEvidence = async (checkId: string, signal?: AbortSignal) =>
    readEvidenceRows(await get(`${COMPLIANCE}/evidence/${seg(checkId)}`, signal));

/** POST /checks/run — runs every check; answers `{ ran, score: { score }, scores }`. */
export async function runAllChecks() {
    return readRunResult(await api.post<unknown>(`${COMPLIANCE}/checks/run`));
}

export async function rerunCheck(checkId: string): Promise<void> {
    await api.post(`${COMPLIANCE}/checks/${seg(checkId)}/run`);
}

/** POST /checks/:id/auto-fix — `{ ok, result: { summary } }`; the check is re-run server-side. */
export async function autoFixCheck(checkId: string): Promise<AutoFixResult> {
    return readAutoFixResult(await api.post<unknown>(`${COMPLIANCE}/checks/${seg(checkId)}/auto-fix`, {}));
}

/** POST /frameworks/:id/enable | disable — NoBody (`.strict()`), so `{}`. */
export async function setFrameworkEnabled(id: string, enabled: boolean): Promise<void> {
    await api.post(`${COMPLIANCE}/frameworks/${seg(id)}/${enabled ? 'enable' : 'disable'}`, {});
}

/** POST /frameworks/:id/relevance — `{ relevance, note? }`. */
export async function setFrameworkRelevance(id: string, relevance: string, note?: string): Promise<void> {
    await api.post(`${COMPLIANCE}/frameworks/${seg(id)}/relevance`, note ? { relevance, note } : { relevance });
}
