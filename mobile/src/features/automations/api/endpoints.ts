/**
 * The automation and run endpoints.
 *
 * Paths are the FULL client-visible ones. The routers read as if mounted at
 * the root, so the prefix comes from server/index.js and is the easiest thing
 * in this codebase to get wrong: /api/automation → routes/automation.js (+
 * routes/automation/*).
 *
 * The mount is licence-gated — requireModule('automation') +
 * requireLicenseFeature('automations') AND, inside the router,
 * requireBetaFeature('automations') — which is why a 402/403 from it is a
 * normal answer and every screen renders it as one. Every payload is read
 * through the allow-list in readers.ts.
 */

import { api } from '@/core/api/client';
import { field, nullable, pick } from '@/core/api/contract';
import { withId } from '@/shared/lib/withId';

import { readSaveResult } from './lifecycle';
import {
    readActiveRunRows,
    readAutomation,
    readAutomationCounts,
    readRun,
    readRunStep,
    readRunTriggerResult,
    readSchedulePreview,
} from './readers';
import type {
    ActiveRun,
    Automation,
    AutomationCounts,
    AutomationDefinition,
    AutomationPatch,
    AutomationRun,
    AutomationRunStep,
    AutomationSaveResult,
    RunTriggerResult,
    SchedulePreview,
} from '../model/types';

const path = (id: string) => `/api/automation/${encodeURIComponent(id)}`;
const runPath = (runId: string) => `/api/automation/runs/${encodeURIComponent(runId)}`;

// ── Automations ─────────────────────────────────────────────────────

export async function listAutomations(signal?: AbortSignal): Promise<Automation[]> {
    const res = await api.get<unknown>('/api/automation', { signal });
    // `kind: 'block'` rows are reusable Steps, not automations — they have no
    // trigger of their own and cannot be run, so they never belong in a list
    // whose whole purpose is "start this".
    return withId(field.list(readAutomation)(pick(res, 'automations'))).filter(
        (a) => a.kind !== 'block',
    );
}

export async function getAutomation(
    id: string,
    signal?: AbortSignal,
): Promise<{ automation: Automation; summary: string } | null> {
    const res = await api.get<unknown>(path(id), { signal });
    const automation = nullable(readAutomation)(pick(res, 'automation'));
    if (!automation) return null;
    return { automation, summary: field.str('')(pick(res, 'summary')) };
}

/**
 * Save an automation: rename, re-describe, re-time — or, from the flow editor,
 * the whole definition. One function for PUT /:id, shared by both features.
 *
 * A schedule change sends the patched DEFINITION, not the `scheduleCron`
 * column. Both work — PUT copies an explicit column straight through — but
 * only the definition keeps the two in step: routes/automation/crud.js derives
 * the columns from the definition on every save, so writing the column alone
 * leaves `definition.trigger.schedule.cron` stale, and the next save from the
 * builder would quietly undo this edit.
 *
 * Saving is validated at the lenient DRAFT stage: only an integrity problem is
 * refused, as a 400 with `details`; what is merely unfinished comes back as
 * `warnings`. A write retries only on a refusal that proves it never ran (the
 * client's rule).
 */
export async function updateAutomation(id: string, patch: AutomationPatch): Promise<AutomationSaveResult> {
    return readSaveResult(await api.put<unknown>(path(id), patch));
}

/**
 * Arm or disarm an automation.
 *
 * Activation is not a flag flip: the server re-validates the whole STORED
 * flow at `stage: 'strict'`, checks every tool against the caller's permitted
 * apps, refuses a hand-written pinned sample and re-arms `next_run_at` — so a
 * 400 here is a real "this cannot go live" with `details`, and the caller must
 * show them rather than a generic failure. Never retried: the refusal is the
 * answer.
 */
export async function setAutomationActive(id: string, active: boolean): Promise<AutomationSaveResult> {
    return readSaveResult(await api.post<unknown>(`${path(id)}/${active ? 'activate' : 'deactivate'}`, undefined, { retry: false }));
}

/**
 * "Make vN live" (handoff 5): the working copy becomes the live version.
 *
 * `version` is the one the person is looking at; when a save landed since,
 * the server answers 409 `version_changed` instead of publishing something
 * they did not see. The checks are activation's own (checkBeforeLive in
 * routes/automation/activate.js), so a refusal reads like one: a 400 with
 * `details`, a 409 from the AI Act gate, a 400 `invalid_schedule`. A paused
 * automation stays paused. Never retried: the refusal is the answer.
 */
export async function publishAutomation(id: string, version: number | null): Promise<AutomationSaveResult> {
    const body = typeof version === 'number' ? { version } : {};
    return readSaveResult(await api.post<unknown>(`${path(id)}/publish`, body, { retry: false }));
}

/**
 * The automation's counts (routes/automation/actions.js GET /:id/counts). The
 * phone reads the pending figure, which a save's answer leaves out.
 */
export async function getAutomationCounts(id: string, signal?: AbortSignal): Promise<AutomationCounts> {
    return readAutomationCounts(await api.get<unknown>(`${path(id)}/counts`, { signal }));
}

/**
 * Start a run now.
 *
 * Three answers, all of them normal (routes/automation/runs.js):
 *   200 { accepted, run, steps }     — it finished inside the 60s sync wait
 *   202 { accepted, pending: true }  — still going; watch the stream instead
 *   200 { accepted, skipped: true }  — a Gmail/Nextcloud trigger with no
 *                                      recent message to test against, which
 *                                      is information, not a failure
 * The client timeout is raised past the server's own 60s cap so the sync path
 * is never cut off by us first. `triggerStepId` enters through one of the
 * automation's additional triggers (the builder's "Start from"); `triggerPayload`
 * is what the run enters with (a trigger's saved sample).
 */
export async function runAutomation(id: string, input: RunInput = {}): Promise<RunTriggerResult | null> {
    const body = {
        ...(input.triggerPayload == null ? {} : { triggerPayload: input.triggerPayload }),
        ...(input.triggerStepId ? { triggerStepId: input.triggerStepId } : {}),
    };
    return nullable(readRunTriggerResult)(await api.post<unknown>(`${path(id)}/run`, body, { timeoutMs: 70_000, retry: false }));
}

export interface RunInput {
    triggerPayload?: unknown;
    triggerStepId?: string | null;
}

// ── Runs ────────────────────────────────────────────────────────────

/** Re-fire a run with its original trigger payload; same 200/202 shapes. */
export async function retryRun(automationId: string, runId: string): Promise<RunTriggerResult | null> {
    return nullable(readRunTriggerResult)(
        await api.post<unknown>(
            `${path(automationId)}/runs/${encodeURIComponent(runId)}/retry`,
            {},
            { timeoutMs: 70_000, retry: false },
        ),
    );
}

/**
 * Ask a run to stop. Answers 202 — the runner honours it at the next
 * between-steps check, so cancel latency is one step, and the caller has to
 * keep watching rather than assume it stopped.
 */
export async function cancelRun(runId: string): Promise<AutomationRun | null> {
    const res = await api.post<unknown>(`${runPath(runId)}/cancel`, {}, { retry: false });
    return nullable(readRun)(pick(res, 'run'));
}

/**
 * Approve or reject the step an `awaiting_approval` run is paused on.
 *
 * Run-keyed, so it serves only a plain single-assignee run pause; anything
 * with panels, stages or quorum is decided by approval id (features/approvals).
 */
export async function decideRunStep(
    runId: string,
    decision: 'approve' | 'reject',
    reason?: string,
): Promise<void> {
    await api.post(
        `${runPath(runId)}/approve-step`,
        { decision, ...(reason ? { reason } : {}) },
        { retry: false },
    );
}

export async function listRuns(
    automationId: string,
    opts: { limit?: number; status?: string } = {},
    signal?: AbortSignal,
): Promise<AutomationRun[]> {
    const res = await api.get<unknown>(`${path(automationId)}/runs`, {
        signal,
        query: { limit: opts.limit ?? 30, status: opts.status },
    });
    return withId(field.list(readRun)(pick(res, 'runs')));
}

/** Cross-automation activity — what the tab's "Recent activity" is built on. */
export async function listRecentRuns(limit = 25, signal?: AbortSignal): Promise<AutomationRun[]> {
    const res = await api.get<unknown>('/api/automation/_runs/recent', {
        signal,
        query: { limit },
    });
    return withId(field.list(readRun)(pick(res, 'runs')));
}

export async function listActiveRuns(signal?: AbortSignal): Promise<ActiveRun[]> {
    const res = await api.get<unknown>('/api/automation/_runs/active', { signal });
    return readActiveRunRows(pick(res, 'active')).filter((r) => r.runId !== '');
}

/**
 * One run. The row you asked for reports the outcome of the LAST leg of its
 * journey — an automation that paused on a form or an approval continues in a
 * child run, and the server folds that back onto this response
 * (`journeyRunId`), so the phone never shows a "success" that was really a
 * hand-off.
 */
export async function getRun(runId: string, signal?: AbortSignal): Promise<AutomationRun | null> {
    const res = await api.get<unknown>(runPath(runId), { signal });
    return nullable(readRun)(pick(res, 'run'));
}

/**
 * The whole journey's steps, plus the flow definition AS IT WAS at run time —
 * so a five-month-old failure still lists the steps that actually existed then
 * rather than today's flow with holes in it.
 */
export async function getRunSteps(
    runId: string,
    signal?: AbortSignal,
): Promise<{ steps: AutomationRunStep[]; definition: AutomationDefinition | null; version: number | null }> {
    const res = await api.get<unknown>(`${runPath(runId)}/steps`, { signal });
    return {
        steps: field.list(readRunStep)(pick(res, 'steps')),
        definition: field.recordOrNull<AutomationDefinition>(pick(res, 'definition')),
        version: field.numOrNull(pick(res, 'version')),
    };
}

/**
 * Next firing times for a cron, computed by the same code the runner uses —
 * so the preview under the picker is bit-exact with what will happen, not an
 * approximation done on the phone.
 */
export async function previewSchedule(cron: string, tz: string, count = 3): Promise<SchedulePreview | null> {
    return nullable(readSchedulePreview)(
        await api.post<unknown>(
            '/api/automation/_schedule/preview',
            { cron, tz, count },
            { retry: false },
        ),
    );
}
