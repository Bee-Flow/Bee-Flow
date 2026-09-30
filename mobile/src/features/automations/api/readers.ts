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
    journeyRunId: field.optStr,
});

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
