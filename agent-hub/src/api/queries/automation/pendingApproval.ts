// The approval a waiting run waits on, as the person deciding it sees it:
// GET /api/automation/runs/:runId/form `pendingApproval` (the server reads the
// approval row's SNAPSHOT, automation/pausedRunFacts.mts pendingApprovalFor).
// The builder's approval bar renders from this, never from the step as it is
// on the canvas now: the server checks the answers against the snapshot.

import { useQuery } from '@tanstack/react-query';
import { API_BASE, authFetch } from '@/utils/helpers';
import { failure } from './http';

interface PendingApprovalField {
    name: string;
    label?: string;
    type?: string;
    required?: boolean;
    [key: string]: unknown;
}

export interface PendingApprovalSnapshot {
    approvalId: string;
    /** The question as it was rendered when the run paused. */
    prompt: string;
    detailsMd: string | null;
    /** The approver's extra questions, as snapshotted at pause. */
    fields: PendingApprovalField[];
    /** May the caller decide it (approvalRulebook.canDecide)? */
    canDecide: boolean;
    waitingOn: { stageName: string | null; seatCount: number } | null;
    /** A test or dry run's approval: the tester decides alone (sandbox seat). */
    isTest: boolean;
}

type Obj = Record<string, unknown>;

const isField = (f: unknown): f is PendingApprovalField => !!f && typeof f === 'object' && typeof (f as Obj).name === 'string';

function waitingOnOf(v: unknown): PendingApprovalSnapshot['waitingOn'] {
    if (!v || typeof v !== 'object') return null;
    const w = v as Obj;
    return {
        stageName: typeof w.stageName === 'string' && w.stageName ? w.stageName : null,
        seatCount: typeof w.seatCount === 'number' ? w.seatCount : 0,
    };
}

/** The snapshot from the route's answer; null when the run does not wait on an approval. */
function readPendingApproval(body: unknown): PendingApprovalSnapshot | null {
    const p = body && typeof body === 'object' ? (body as Obj).pendingApproval : null;
    if (!p || typeof p !== 'object') return null;
    const a = p as Obj;
    return {
        approvalId: String(a.approvalId ?? ''),
        prompt: typeof a.prompt === 'string' ? a.prompt : '',
        detailsMd: typeof a.detailsMd === 'string' && a.detailsMd ? a.detailsMd : null,
        fields: Array.isArray(a.fields) ? a.fields.filter(isField) : [],
        canDecide: a.canDecide === true,
        waitingOn: waitingOnOf(a.waitingOn),
        isTest: a.isTest === true,
    };
}

async function fetchPendingApproval(runId: string): Promise<PendingApprovalSnapshot | null> {
    const res = await authFetch(`${API_BASE}/api/automation/runs/${encodeURIComponent(runId)}/form`);
    if (!res.ok) throw await failure(res, 'Could not read the approval this run waits on.');
    return readPendingApproval(await res.json().catch(() => null));
}

const pendingApprovalKey = (runId: string | null, stepId: string | null) => ['automation', 'pending-approval', runId, stepId] as const;

/**
 * The snapshot of the approval `runId` (any run of the journey) waits on at
 * `stepId`. Keyed on the step too, so a journey that pauses on a second
 * approval reads that one.
 */
export function usePendingApproval(runId: string | null, stepId: string | null) {
    return useQuery({
        queryKey: pendingApprovalKey(runId, stepId),
        queryFn: () => fetchPendingApproval(runId as string),
        enabled: !!runId,
        retry: false,
        staleTime: 0,
    });
}
