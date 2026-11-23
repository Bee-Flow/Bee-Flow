// The plan of a Cowork item over /api/cowork/:id/plan, through the typed request layer: the path, its
// parameters and the bodies are checked against the server's own schemas (apiTypes.generated.ts).
// A refusal throws with the server's sentence (mutate.ts RefusedError), which the plan card shows.

import { apiJson } from './typedRequest';
import type { PlanAutomation, PlanState, PlanTryStart, PlanTryState } from './coworkPlan.types';

export function getCoworkPlan(id: string): Promise<PlanState> {
    return apiJson<'GET /api/cowork/{id}/plan', PlanState>('GET /api/cowork/{id}/plan', { params: { id } });
}

/** Name the automation this item's plan is made from. Approves nothing. */
export function attachCoworkPlan(id: string, automationId: string): Promise<PlanState> {
    return apiJson<'PUT /api/cowork/{id}/plan', PlanState>('PUT /api/cowork/{id}/plan', { params: { id }, body: { automationId } });
}

/** Approve the plan that was looked at: `fingerprint` is the one the card showed. */
export function approveCoworkPlan(id: string, fingerprint: string): Promise<PlanState> {
    return apiJson<'POST /api/cowork/{id}/plan/approve', PlanState>('POST /api/cowork/{id}/plan/approve', { params: { id }, body: { fingerprint } });
}

/** Take the plan off: the item runs as a prompt or as its agent again. */
export function removeCoworkPlan(id: string): Promise<PlanState> {
    return apiJson<'DELETE /api/cowork/{id}/plan', PlanState>('DELETE /api/cowork/{id}/plan', { params: { id } });
}

/** Try the plan once: reads run for real, nothing is changed or sent. Answers as soon as the try-out started. */
export function startCoworkPlanTry(id: string): Promise<PlanTryStart> {
    return apiJson<'POST /api/cowork/{id}/plan/try', PlanTryStart>('POST /api/cowork/{id}/plan/try', { params: { id } });
}

/** How a try-out is going, step by step. */
export function getCoworkPlanTry(id: string, tryId: string): Promise<PlanTryState> {
    return apiJson<'GET /api/cowork/{id}/plan/try/{tryId}', PlanTryState>('GET /api/cowork/{id}/plan/try/{tryId}', { params: { id, tryId } });
}

/** The automations of a list response that the caller owns: a plan is made from one of your own. */
export function ownAutomationsOf(body: unknown): PlanAutomation[] {
    const rows = body && typeof body === 'object' && Array.isArray((body as { automations?: unknown }).automations)
        ? (body as { automations: unknown[] }).automations
        : [];
    const out: PlanAutomation[] = [];
    for (const row of rows) {
        if (!row || typeof row !== 'object') continue;
        const r = row as { id?: unknown; title?: unknown; role?: unknown };
        if (typeof r.id !== 'string' || !r.id) continue;
        if (r.role !== undefined && r.role !== 'owner') continue;
        out.push({ id: r.id, title: typeof r.title === 'string' && r.title.trim() ? r.title : r.id });
    }
    return out;
}

export async function listPlanAutomations(): Promise<PlanAutomation[]> {
    return ownAutomationsOf(await apiJson('GET /api/automation'));
}
