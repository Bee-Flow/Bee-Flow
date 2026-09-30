/**
 * Creating and deleting a routine, and the question to ask before deleting
 * one: which app buttons start it.
 *
 * routes/automation/crud.js. A new row is always a DRAFT (`isDraft: true`,
 * inactive) and is validated at the lenient draft stage, so a half-built
 * flow can be created — the incomplete parts come back as warnings; only an
 * integrity error is a 400 with `details`.
 */

import { api } from '@/core/api/client';
import { field, nullable, pick, shapeListOf } from '@/core/api/contract';

import { readIssues } from './issues';
import { readAutomation } from './readers';
import type {
    AutomationUsage,
    AutomationUsageRow,
    AutomationSaveResult,
    CreateAutomationBody,
    CreateAutomationResult,
} from '../model/types';

const path = (id: string) => `/api/automation/${encodeURIComponent(id)}`;

/** The row and the (non-blocking) findings of a create, an import or a template install. */
export function readCreateResult(raw: unknown): CreateAutomationResult {
    return {
        automation: nullable(readAutomation)(pick(raw, 'automation')),
        warnings: readIssues(pick(raw, 'warnings'), 'warning'),
    };
}

/** PUT /:id and POST /:id/activate: a create's answer, plus the form's answers-table outcome. */
export function readSaveResult(raw: unknown): AutomationSaveResult {
    return { ...readCreateResult(raw), answers: field.recordOrNull(pick(raw, 'answers')) };
}

/**
 * Create a routine. Never retried: a create that timed out may have landed,
 * and a second POST is a second routine.
 */
export async function createAutomation(body: CreateAutomationBody): Promise<CreateAutomationResult> {
    return readCreateResult(await api.post<unknown>('/api/automation', body, { retry: false }));
}

/**
 * Delete a routine. The server revokes its remote subscriptions first and
 * keeps a form's answers tables as ordinary tables, so nothing anyone
 * answered is lost with it. `false` when the row was already gone.
 */
export async function deleteAutomation(id: string): Promise<boolean> {
    const res = await api.delete<unknown>(path(id), { retry: false });
    return field.bool(false)(pick(res, 'success'));
}

const readUsageRows: (raw: unknown) => AutomationUsageRow[] = shapeListOf({
    automationId: field.str(''),
    consumerKind: field.str(''),
    consumerId: field.str(''),
    consumerTitle: field.strOrNull,
    refId: field.strOrNull,
    actionId: field.strOrNull,
    screenId: field.strOrNull,
    nodeId: field.strOrNull,
    label: field.strOrNull,
    wired: field.bool(true),
    updatedAt: field.strOrNull,
    canOpen: field.bool(false),
});

/** GET /:id/usage. `complete` reads fail-closed: anything but `true` is "not sure". */
export function readUsage(raw: unknown): AutomationUsage {
    return {
        usage: readUsageRows(pick(raw, 'usage')),
        complete: pick(raw, 'complete') === true,
    };
}

/**
 * Which app buttons start this routine.
 *
 * A failed read THROWS (the server answers 500 `usage_unavailable`, never an
 * empty list): "used nowhere" is exactly the sentence on which somebody
 * deletes a routine a button in production depends on, so the screen must say
 * "could not be checked" instead.
 */
export async function getAutomationUsage(id: string, signal?: AbortSignal): Promise<AutomationUsage> {
    return readUsage(await api.get<unknown>(`${path(id)}/usage`, { signal }));
}
