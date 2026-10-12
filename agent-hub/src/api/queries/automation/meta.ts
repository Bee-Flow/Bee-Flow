// Builder header data: the tab counts and the "Make vN live" call.
//
// The ONLY place that knows these two wire contracts
// (GET /api/automation/:id/counts and POST /api/automation/:id/publish), so a
// server change is adjusted here and nowhere else.
//
// `authFetch` rather than `apiClient`: the header renders "no count" for a
// failed read, and the tests mock `authFetch` with a bare `{ ok, status, json }`.

import { useQuery } from '@tanstack/react-query';
import { API_BASE, authFetch } from '../../../utils/helpers';
import { errorBody } from '../../../hooks/useAutomationApi';

/** GET /:id/counts, normalised. A count the server did not send is null, never 0. */
interface AutomationCounts {
    runs7d: number | null;
    runsFailed7d: number | null;
    versions: number | null;
    pendingChanges: number | null;
}

const automationMetaKeys = {
    all: ['automation-meta'] as const,
    // The row's version and live state are part of the key: every save or
    // publish that moves them refetches the counts without an invalidation,
    // so the shell does not need a QueryClient of its own.
    counts: (id: string, stamp: string) => ['automation-meta', 'counts', id, stamp] as const,
};

function num(v: unknown): number | null {
    return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
}

/** Normalise one response body. Exported for the test; tolerant of junk. */
export function parseAutomationCounts(body: unknown): AutomationCounts {
    const raw = body && typeof body === 'object' ? body as Record<string, unknown> : {};
    return {
        runs7d: num(raw.runs7d),
        runsFailed7d: num(raw.runsFailed7d),
        versions: num(raw.versions),
        pendingChanges: num(raw.pendingChanges),
    };
}

async function fetchAutomationCounts(id: string, signal?: AbortSignal): Promise<AutomationCounts> {
    const res = await authFetch(`${API_BASE}/api/automation/${encodeURIComponent(id)}/counts`, { signal });
    if (!res.ok) throw new Error(`automation counts ${res.status}`);
    return parseAutomationCounts(await res.json());
}

/**
 * The header's tab counts. `id` null (an automation with no server row yet)
 * never fetches. `stamp` is whatever changes when the counts can have moved.
 */
export function useAutomationCounts(id: string | null | undefined, stamp: string) {
    return useQuery({
        queryKey: automationMetaKeys.counts(id || '', stamp),
        queryFn: ({ signal }) => fetchAutomationCounts(id as string, signal),
        enabled: !!id,
        staleTime: 30_000,
    });
}

/** An error that carries the server's `code` (e.g. ai_act_check_required). */
interface AutomationMetaError extends Error {
    status?: number;
    code?: string;
}

/**
 * POST /:id/publish: the working copy becomes the live version. `version` is
 * the one the person saw; the server answers 409 `version_changed` when the
 * automation moved on since, and 409 `ai_act_check_required` when the AI Act
 * check has to be done first. Returns the updated row.
 */
export async function publishAutomation(id: string, version?: number | null): Promise<{ automation: Record<string, unknown>; warnings?: unknown[] }> {
    const res = await authFetch(`${API_BASE}/api/automation/${encodeURIComponent(id)}/publish`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(typeof version === 'number' ? { version } : {}),
    });
    if (!res.ok) {
        // Read like every other builder call (hooks/useAutomationApi.ts), so a
        // 400 "Invalid definition" says which step is incomplete.
        const { message, code } = await errorBody(res);
        const err: AutomationMetaError = new Error(message || `publish failed (${res.status})`);
        err.status = res.status;
        if (code) err.code = code;
        throw err;
    }
    return await res.json() as { automation: Record<string, unknown>; warnings?: unknown[] };
}

// The two refusals of the AI Act gate (server/routes/automation/activate.js
// checkBeforeLive): no valid check yet, or a check that found a prohibited
// practice. Both are answered in Settings → AI Act check.
const AI_ACT_REFUSALS = new Set(['ai_act_check_required', 'ai_act_prohibited']);

/** True for a refusal that sends the person to Settings → AI Act. */
export function isAiActRefusal(e: unknown): boolean {
    const code = !!e && typeof e === 'object' ? (e as { code?: unknown }).code : null;
    return typeof code === 'string' && AI_ACT_REFUSALS.has(code);
}
