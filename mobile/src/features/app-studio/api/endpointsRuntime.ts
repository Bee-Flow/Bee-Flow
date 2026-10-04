/**
 * The run view: the runtime payload and the action bridge
 * (server/routes/studioApps.js GET /:id/runtime, server/routes/
 * studioAppsRun.js). The runtime's action runner calls runAction, runStep and
 * pollRun directly — they are plain async functions, not hooks.
 */

import { api } from '@/core/api/client';

import { appPath, draftQuery } from './paths';
import { readActionRun, readRuntime, readStep } from './readersRuntime';
import type { ActionRunResult, AppRuntime, RunActionInput, StepInput, StepResult } from '../model/runtimeTypes';

/** The web's STEP_DEADLINE_MS: above the server's own AI ceiling, so its message wins. */
export const STEP_TIMEOUT_MS = 135_000;
/** The server waits up to 60 s before answering 202; a little slack on top. */
export const RUN_TIMEOUT_MS = 70_000;

const actionPath = (appId: string, actionId: string) =>
    `${appPath(appId)}/actions/${encodeURIComponent(actionId)}`;

/**
 * The run-view payload. `draft: true` is the owner's working draft; anyone
 * else (the owner too, without it) runs the frozen published copy. An
 * unpublished app is a 404 for non-owners; a same-org member outside the
 * audience gets 403 `not_in_audience`.
 */
export async function getRuntime(
    id: string,
    opts: { draft?: boolean; signal?: AbortSignal } = {},
): Promise<AppRuntime> {
    return readRuntime(
        await api.get<unknown>(`${appPath(id)}/runtime`, { signal: opts.signal, query: draftQuery(opts.draft) }),
    );
}

/**
 * Run a `run_automation` action. 200 = the final answer; 202 = `{ runId,
 * status: 'pending' }` past the server's wait (poll with pollRun);
 * `status: 'skipped'` = the automation was already running. Inputs resolve
 * server-side from the action's own inputMapping — formValues only feed
 * `field` mappings. Never retried: a run that timed out may still be running.
 */
export async function runAction(
    appId: string,
    actionId: string,
    input: RunActionInput = {},
): Promise<ActionRunResult> {
    const body = { formValues: input.formValues ?? {}, wait: input.wait ?? true };
    const res = await api.post<unknown>(`${actionPath(appId, actionId)}/run`, body, {
        query: draftQuery(input.draft),
        retry: false,
        timeoutMs: RUN_TIMEOUT_MS,
    });
    return readActionRun(res);
}

/**
 * Execute ONE server step of a sequence action, resolved server-side from the
 * definition by pre-order `stepIndex`. `ok: false` is the step's own failure
 * (with `code: 'quota_exceeded'` and `limit`/`used` for a quota); a 4xx
 * (unknown step, a client-only or streaming step, no access) throws.
 */
export async function runStep(appId: string, actionId: string, input: StepInput): Promise<StepResult> {
    const { draft, ...rest } = input;
    const body = { ...rest, formValues: rest.formValues ?? {}, vars: rest.vars ?? {} };
    const res = await api.post<unknown>(`${actionPath(appId, actionId)}/step`, body, {
        query: draftQuery(draft),
        retry: false,
        timeoutMs: STEP_TIMEOUT_MS,
    });
    return readStep(res);
}

/** Poll a 202'd run. Same body as the synchronous answer. */
export async function pollRun(appId: string, runId: string, signal?: AbortSignal): Promise<ActionRunResult> {
    return readActionRun(
        await api.get<unknown>(`${appPath(appId)}/actions/runs/${encodeURIComponent(runId)}`, { signal }),
    );
}
