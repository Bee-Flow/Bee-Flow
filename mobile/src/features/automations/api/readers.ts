/**
 * Contract readers for the automation payloads — one spec per row mapper the
 * server has (see model/types.ts for the sources).
 *
 * `RunStatus` is a widened string union, so any string reads as a status;
 * statusToken() in model/status.ts degrades the unknown ones to `idle`. Blobs
 * the phone only carries (trigger payloads, step input/output, flow
 * definitions) pass through as they are.
 */

import { field, nullable, pick, shapeListOf, shapeOf } from '@/core/api/contract';

import type {
    ActiveRun,
    Automation,
    AutomationCounts,
    AutomationDefinition,
    AutomationRun,
    AutomationRunStep,
    RunDecisionResult,
    RunPendingApproval,
    RunProfileView,
    RunTriggerResult,
    SchedulePreview,
} from '../model/types';

/**
 * A live-split field (model/types.ts): absent stays absent, which is how an
 * older server says it has no split, and null stays null.
 */
const optNumOrNull = (value: unknown): number | null | undefined => (value === undefined ? undefined : field.numOrNull(value));
const optStrOrNull = (value: unknown): string | null | undefined => (value === undefined ? undefined : field.strOrNull(value));

export const readAutomation: (raw: unknown) => Automation = shapeOf({
    id: field.str(''),
    userId: field.str(''),
    organizationId: field.strOrNull,
    projectId: field.strOrNull,
    folderId: field.strOrNull,
    kind: field.str('automation'),
    title: field.str('Untitled automation'),
    description: field.strOrNull,
    definition: field.record<AutomationDefinition>({}),
    version: field.num(0),
    isActive: field.bool(false),
    isDraft: field.bool(false),
    needsFirstRunConfirm: field.bool(false),
    triggerType: field.str('manual'),
    scheduleCron: field.strOrNull,
    scheduleTz: field.strOrNull,
    nextRunAt: field.strOrNull,
    lastRunAt: field.strOrNull,
    lastStatus: field.strOrNull,
    runningInstanceId: field.strOrNull,
    runningStartedAt: field.strOrNull,
    icon: field.strOrNull,
    createdAt: field.strOrNull,
    updatedAt: field.strOrNull,
    liveVersion: optNumOrNull,
    liveAt: optStrOrNull,
    neverLive: field.optBool,
    pendingChanges: field.optNum,
    canStart: field.optBool,
});

/** GET /:id/counts (routes/automation/actions.js). The phone reads the pending figure; the tab counts are the web header's. */
export const readAutomationCounts: (raw: unknown) => AutomationCounts = shapeOf({
    pendingChanges: field.numOrNull,
});

export const readRun: (raw: unknown) => AutomationRun = shapeOf({
    id: field.str(''),
    automationId: field.str(''),
    version: field.num(0),
    userId: field.str(''),
    triggerKind: field.strOrNull,
    triggerPayload: field.raw,
    mode: field.strOrNull,
    status: field.str('queued'),
    startedAt: field.strOrNull,
    finishedAt: field.strOrNull,
    durationMs: field.numOrNull,
    error: field.strOrNull,
    summary: field.strOrNull,
    parentRunId: field.strOrNull,
    rootRunId: field.str(''),
    cancelRequested: field.bool(false),
    awaitingStepId: field.strOrNull,
    awaitingStepExpiresAt: field.strOrNull,
    errorClass: field.strOrNull,
    handledErrorCount: field.num(0),
    canStart: field.optBool,
    journeyRunId: field.optStr,
    isTest: field.optBool,
    profile: (value: unknown) => field.optRecord<RunProfileView>(value),
    canDecide: field.optBool,
    waitingOn: (value: unknown) => readWaitingOn(value) ?? undefined,
    approvalId: optStrOrNull,
    versionBehind: field.optBool,
});

/** `waitingOn` ({ stageName, seatCount }), or null when it is not one. */
function readWaitingOn(value: unknown): { stageName: string | null; seatCount: number } | null {
    if (!value || typeof value !== 'object') return null;
    return { stageName: field.strOrNull(pick(value, 'stageName')), seatCount: field.num(0)(pick(value, 'seatCount')) };
}

/** GET /runs/:runId/form `pendingApproval`; null when the server sent none (not waiting, or an older server). */
export function readRunPendingApproval(raw: unknown): RunPendingApproval | null {
    const approvalId = field.str('')(pick(raw, 'approvalId'));
    if (!approvalId) return null;
    return {
        approvalId,
        prompt: field.str('')(pick(raw, 'prompt')),
        fields: field.list((f: unknown) => field.record<Record<string, unknown>>({})(f))(pick(raw, 'fields')),
        canDecide: field.bool(false)(pick(raw, 'canDecide')),
        waitingOn: readWaitingOn(pick(raw, 'waitingOn')),
        isTest: field.bool(false)(pick(raw, 'isTest')),
    };
}

const DECISIONS = ['approve', 'reject'] as const;

/**
 * POST /runs/:runId/approve-step's answer. `vote_recorded` is a vote, not a
 * decision: the run still waits. A 202 carries the continuation's runId.
 */
export function readRunDecisionResult(raw: unknown, fallback: 'approve' | 'reject'): RunDecisionResult {
    const said = field.str('')(pick(raw, 'decision'));
    if (said === 'vote_recorded') return { kind: 'vote', stage: field.strOrNull(pick(raw, 'stage')) };
    const decision = field.oneOf(DECISIONS, fallback)(said);
    if (pick(raw, 'pending') === true) return { kind: 'pending', decision, runId: field.strOrNull(pick(raw, 'runId')) };
    return { kind: 'decided', decision, run: nullable(readRun)(pick(raw, 'run')) };
}

export const readRunStep: (raw: unknown) => AutomationRunStep = shapeOf({
    runId: field.str(''),
    stepId: field.str(''),
    parentStepId: field.strOrNull,
    stepType: field.strOrNull,
    attempts: field.numOrNull,
    status: field.str('queued'),
    startedAt: field.strOrNull,
    finishedAt: field.strOrNull,
    input: field.raw,
    output: field.raw,
    error: field.strOrNull,
    errorClass: field.strOrNull,
    branchIndex: field.numOrNull,
    errorRemediation: field.optStr,
});

export const readActiveRunRows: (raw: unknown) => ActiveRun[] = shapeListOf({
    runId: field.str(''),
    automationId: field.str(''),
    status: field.str('running'),
    startedAt: field.strOrNull,
    triggerKind: field.strOrNull,
});

export const readRunTriggerResult: (raw: unknown) => RunTriggerResult = shapeOf({
    accepted: field.optBool,
    pending: field.optBool,
    skipped: field.optBool,
    message: field.optStr,
    run: (value: unknown) => nullable(readRun)(value) ?? undefined,
    steps: field.optList(readRunStep),
});

export function readSchedulePreview(raw: unknown): SchedulePreview {
    if (pick(raw, 'valid') === true) {
        return {
            valid: true,
            cron: field.str('')(pick(raw, 'cron')),
            tz: field.str('')(pick(raw, 'tz')),
            next: field.strArray(pick(raw, 'next')),
        };
    }
    return { valid: false, error: field.optStr(pick(raw, 'error')) };
}
