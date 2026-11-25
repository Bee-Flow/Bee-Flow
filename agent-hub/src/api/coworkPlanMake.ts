// "Make a plan": POST /api/cowork/:id/plan/make and its stream (server/routes/coworkPlannerRoutes.js). A refusal
// comes back as an ordinary answer with a sentence; otherwise the answer is a stream of `progress`, ending in `done`
// with the plan, or in `error` with a sentence.
//
// The request is handed in (by default the typed request layer), so a test reads a stream it wrote itself.

import { apiFetch } from './typedRequest';
import { readEventStream } from './readEventStream';
import type { PlanMakeOutcome, PlanMakeProgress, PlanState } from './coworkPlan.types';

type MakeRequest = (id: string, signal: AbortSignal, fromRuns?: boolean) => Promise<Response>;

const defaultRequest: MakeRequest = (id, signal, fromRuns = false) => apiFetch('POST /api/cowork/{id}/plan/make', { params: { id }, ...(fromRuns ? { body: { fromRuns: true } } : {}), init: { signal } });

interface MakeEvent {
    error?: unknown;
    summary?: unknown;
    state?: PlanState;
}

/** The sentence of an answer that is no stream. */
async function refusalOf(response: Response): Promise<string> {
    // An answer that is not JSON (a gateway's page) has no sentence: the status says it.
    const body = (await response.json().catch(() => null)) as { error?: unknown } | null;
    return typeof body?.error === 'string' && body.error ? body.error : `HTTP ${response.status}`;
}

const text = (value: unknown): string => (typeof value === 'string' ? value : '');

/**
 * Make the plan of an item and follow it until it is over. Resolves with how it ended; a stop by the caller (the
 * signal) rejects with the AbortError, like any stopped request.
 */
export async function makeCoworkPlan(
    id: string,
    { signal, onProgress, fromRuns = false }: { signal: AbortSignal; onProgress?: (progress: PlanMakeProgress) => void; fromRuns?: boolean },
    request: MakeRequest = defaultRequest,
): Promise<PlanMakeOutcome> {
    // fromRuns: "make it routine", the planner reads what the item's past runs did.
    const response = await request(id, signal, fromRuns);
    if (!response.ok || !response.body) return { state: null, summary: '', error: await refusalOf(response) };
    const outcome: PlanMakeOutcome = { state: null, summary: '', error: null };
    for await (const { event, data } of readEventStream<MakeEvent | PlanMakeProgress>(response, { signal })) {
        if (event === 'progress') onProgress?.(data as PlanMakeProgress);
        else if (event === 'done') Object.assign(outcome, { state: (data as MakeEvent).state ?? null, summary: text((data as MakeEvent).summary) });
        else if (event === 'error') outcome.error = text((data as MakeEvent).error) || null;
    }
    // A stream that ended without saying how is a failure, not a plan.
    if (!outcome.state && !outcome.error) outcome.error = '';
    return outcome;
}
