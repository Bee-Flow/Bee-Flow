/**
 * The routine as the editor loads, saves, creates and arms it
 * (routes/automation/crud.js and activate.js, mounted at /api/automation).
 *
 * Saving is validated at the lenient DRAFT stage: only an integrity problem
 * is refused, as a 400 `{ error: 'Invalid definition', details: [issue] }`;
 * everything that is merely unfinished comes back as `warnings`. Activation
 * runs the STRICT pass and answers a refusal the same way, so both feed the
 * editor's issue list through the same reader (automations' readIssues).
 *
 * A save sends the DEFINITION, never the trigger columns: the server derives
 * `triggerType`/`scheduleCron`/`scheduleTz` from it on every PUT, which keeps
 * the scheduler's columns and the graph in step.
 */

import { ApiError } from '@/core/api/client';
import {
    createAutomation,
    getAutomation,
    publishAutomation,
    setAutomationActive,
    updateAutomation,
    type Automation,
    type AutomationSaveResult,
} from '@/features/automations';

import type { FlowAutomation, FlowPatch, SaveResult } from './types';
import { asDefinition } from '../model/normalize';
import type { FlowDefinition } from '../model/types';

export const flowPath = (id: string) => `/api/automation/${encodeURIComponent(id)}`;

/*
 * Every call below is the automations feature's (one function per server
 * call); this module only re-reads the row's definition into the editor's
 * strict shape.
 */

const flowRow = (row: Automation | null): FlowAutomation | null => (row ? { ...row, definition: asDefinition(row.definition) } : null);

const flowResult = (result: AutomationSaveResult): SaveResult => ({
    automation: flowRow(result.automation),
    warnings: result.warnings,
    answers: result.answers,
});

/** GET /:id — owner only (403 otherwise). Null when the answer holds no row. */
export async function getFlowAutomation(
    id: string,
    signal?: AbortSignal,
): Promise<{ automation: FlowAutomation; summary: string } | null> {
    const found = await getAutomation(id, signal);
    const automation = flowRow(found?.automation ?? null);
    return found && automation ? { automation, summary: found.summary } : null;
}

/**
 * PUT /:id with any subset of UpdateAutomationBody. The body is strict on the
 * server, so only the keys of FlowPatch may be sent. The editor's autosave
 * owns every retry the client's rule does not.
 */
export async function saveFlow(id: string, patch: FlowPatch): Promise<SaveResult> {
    return flowResult(await updateAutomation(id, patch));
}

/** POST / — a new routine, created as a draft. */
export async function createFlow(body: { title: string; definition: FlowDefinition; description?: string | null }): Promise<SaveResult> {
    return flowResult({ ...(await createAutomation(body)), answers: null });
}

/**
 * Arm or disarm the routine. Arming re-validates the STORED definition at the
 * strict stage — so the editor flushes its autosave first. A refusal is a 400
 * whose `details` are the reasons; `issueDetailsOf` reads them.
 */
export async function setFlowActive(id: string, active: boolean): Promise<SaveResult> {
    return flowResult(await setAutomationActive(id, active));
}

/**
 * "Make vN live": the working copy becomes the live version (handoff 5).
 * `version` is the one on screen; the refusals are activation's (see
 * setFlowActive), plus 409 `version_changed` when a save landed since.
 */
export async function publishFlow(id: string, version: number | null): Promise<SaveResult> {
    return flowResult(await publishAutomation(id, version));
}

/** The routine moved on since the version the person was looking at (publish, or activating a never-live routine). */
export function isVersionChanged(err: unknown): boolean {
    return err instanceof ApiError && err.status === 409 && err.code === 'version_changed';
}
