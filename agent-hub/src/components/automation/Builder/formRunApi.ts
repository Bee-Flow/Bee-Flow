/**
 * The form test overlay's calls to the server (FormRunOverlay):
 *
 *   readRunForm        GET  /runs/:id/form       the page, the approval or the ending the journey is on
 *   readRunKind        GET  /runs/:id            the run's profile, for the chip of an attached run
 *   continueRunForm    POST /runs/:id/form       answer a later page; 202 { runId } of the continuation
 *   decideRunApproval  POST /runs/:id/approve-step  decide the approval it waits on; 202 { runId }
 *   discardRun         POST /runs/:id/cancel     close a parked test run (a form wait, or withdraw the approval)
 *   uploadFormTestFile POST /:id/form-test/upload  one file for a question on page one
 *
 * Every write asks the server to answer as soon as the continuation exists
 * (respond 'created'); the overlay and the canvas then follow it by id.
 */

import apiClient, { createJsonResource } from '@/api/client';
import { API_BASE } from '@/utils/helpers';
import { errorBodyRecord } from '@/utils/caughtError';
import { runPhase, type RunPhaseInput } from './runs/runPhase';
import type { FormDef } from '../../forms/PublicFormRenderer.types';
import type { ApprovalField } from '../../admin/Studio/Approvals/ApprovalDecisionControls';
import type { FormRunKind } from './formRunContract';

/** The approval a journey waits on, as GET /runs/:id/form describes it (the approval row's snapshot). */
export interface PendingApproval {
    approvalId: string;
    prompt: string;
    detailsMd?: string | null;
    fields?: ApprovalField[] | null;
    /** The caller may decide it: always for a test run (the sandbox seat), or the automation's owner. */
    canDecide: boolean;
    /** Who it waits on: the current stage's name and seats, a panel's seats, or one person. */
    waitingOn?: { stageName?: string | null; seatCount?: number | null } | null;
    isTest?: boolean;
}

/** GET /runs/:id/form, addressed to the journey's actionable leg. */
export interface RunFormState {
    runId?: string;
    status?: string;
    waiting?: boolean;
    stepId?: string | null;
    form?: FormDef;
    pendingApproval?: PendingApproval | null;
    /** The closing page a finished journey ended on; null when it had none. */
    ending?: FormDef | null;
}

/** A run start or continuation answer: 202 { runId }, or the run itself. */
interface ContinueReply { runId?: string; run?: { id?: string } | null }

const runPath = (runId: string) => `/api/automation/runs/${encodeURIComponent(runId)}`;
const nextRunId = (out: ContinueReply | null | undefined, fallback: string) => out?.runId || out?.run?.id || fallback;

/** A refused answer that names its questions keeps them in `fields`, where the form renderer looks. */
function withFieldErrors(e: unknown): unknown {
    const fields = errorBodyRecord(e)?.fields;
    if (!Array.isArray(fields) || !fields.length || !(e instanceof Error)) return e;
    return Object.assign(e, { fields });
}

export async function readRunForm(runId: string): Promise<RunFormState | null> {
    return apiClient.get<RunFormState>(`${runPath(runId)}/form`);
}

/** Dry run, live test or production, from the run's profile (legacy rows: mode and isTest). */
export async function readRunKind(runId: string): Promise<FormRunKind | null> {
    const body = await apiClient.get<{ run?: RunPhaseInput | null }>(runPath(runId));
    if (!body?.run) return null;
    const { isDry, isTest } = runPhase(body.run);
    if (isDry) return 'dry';
    return isTest ? 'live' : 'production';
}

export async function continueRunForm(runId: string, stepId: string, values: Record<string, unknown>): Promise<string> {
    try {
        const out = await apiClient.post<ContinueReply>(`${runPath(runId)}/form`, { stepId, values, respond: 'created' });
        return nextRunId(out, runId);
    } catch (e) {
        throw withFieldErrors(e);
    }
}

export async function decideRunApproval(runId: string, decision: string, reason?: string, answers?: unknown): Promise<string> {
    const out = await apiClient.post<ContinueReply>(`${runPath(runId)}/approve-step`, { decision, reason, answers, respond: 'created' });
    return nextRunId(out, runId);
}

export async function discardRun(runId: string): Promise<void> {
    await apiClient.post(`${runPath(runId)}/cancel`, {});
}

export interface UploadedFile { fileId: string; filename: string; size: number }

/** One file for page one's file question; the form test claims it by its fileId. */
export async function uploadFormTestFile(automationId: string, file: File, field: string, triggerStepId?: string | null): Promise<UploadedFile> {
    const body = new FormData();
    body.append('field', field);
    if (triggerStepId) body.append('triggerStepId', triggerStepId);
    body.append('file', file);
    const send = createJsonResource(`${API_BASE}/api/automation`);
    return send<UploadedFile>(`/${encodeURIComponent(automationId)}/form-test/upload`, { method: 'POST', body });
}
