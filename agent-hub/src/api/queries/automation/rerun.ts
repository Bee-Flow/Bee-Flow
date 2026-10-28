// Re-run from a step with the data of an earlier run: the plan the server
// reports first (GET /:id/steps/:stepId/rerun-plan) and the run itself
// (POST /:id/steps/:stepId/run with seedRunId). The server refuses to run
// anything that sends or writes until the caller confirmed it.

import { API_BASE, authFetch } from '@/utils/helpers';
import { failure } from './http';

export interface RerunSideEffect {
    stepId: string;
    type: string;
    tool: string | null;
    label: string | null;
    effect: 'writes' | 'sends';
}

export interface RerunPlan {
    seedRunId: string;
    /** Every step that would execute (an upper bound: untaken branches are in it). */
    willExecute: string[];
    /** Steps the chosen run has no recorded output for. */
    missingUpstream: string[];
    sideEffects: RerunSideEffect[];
    requiresConfirm: boolean;
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

/** The wire plan, reduced to what the screen uses. Exported for the test. */
function parseRerunPlan(raw: unknown): RerunPlan {
    const p = isRecord(raw) ? raw : {};
    const effects = Array.isArray(p.sideEffects) ? p.sideEffects : [];
    return {
        seedRunId: typeof p.seedRunId === 'string' ? p.seedRunId : '',
        willExecute: strings(p.willExecute),
        missingUpstream: strings(p.missingUpstream),
        sideEffects: effects.filter(isRecord).map((e) => ({
            stepId: String(e.stepId ?? ''),
            type: String(e.type ?? ''),
            tool: typeof e.tool === 'string' ? e.tool : null,
            label: typeof e.label === 'string' ? e.label : null,
            effect: e.effect === 'sends' ? 'sends' : 'writes',
        })),
        requiresConfirm: p.requiresConfirm === true,
    };
}

const stepUrl = (automationId: string, stepId: string, tail: string) =>
    `${API_BASE}/api/automation/${encodeURIComponent(automationId)}/steps/${encodeURIComponent(stepId)}/${tail}`;

/** What re-running from `stepId` with the data of `seedRunId` would do, without doing it. */
export async function fetchRerunPlan(automationId: string, stepId: string, seedRunId: string): Promise<RerunPlan> {
    const q = new URLSearchParams({ seedRunId, mode: 'from' });
    const res = await authFetch(stepUrl(automationId, stepId, `rerun-plan?${q.toString()}`));
    if (!res.ok) throw await failure(res, `Re-run plan ${res.status}`);
    const body: unknown = await res.json().catch(() => null);
    return parseRerunPlan(isRecord(body) ? body.rerunPlan : null);
}

/** Run `stepId` and everything after it, fed by the recorded outputs of `seedRunId`. Resolves to the new run's id. */
export async function rerunFromStep(
    automationId: string, stepId: string, seedRunId: string, confirmSideEffects: boolean,
): Promise<string | null> {
    const res = await authFetch(stepUrl(automationId, stepId, 'run'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'from', seedRunId, confirmSideEffects }),
    });
    if (!res.ok) throw await failure(res, `Re-run ${res.status}`);
    const body: unknown = await res.json().catch(() => null);
    const run = isRecord(body) && isRecord(body.run) ? body.run : null;
    return run && typeof run.id === 'string' ? run.id : null;
}
