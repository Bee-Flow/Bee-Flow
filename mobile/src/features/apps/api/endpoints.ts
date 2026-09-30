/**
 * The Studio app endpoints: /api/studio-apps → routes/studioApps.js and
 * routes/studioAppsRun.js. The mount is gated by requireModule('apps') +
 * requireCapability('app_studio'), so a 402/403 is a normal answer.
 */

import { api } from '@/core/api/client';
import { field, nullable, pick } from '@/core/api/contract';
import { withId } from '@/shared/lib/withId';

import { readAppActionResult, readAppRuntime, readStudioApp } from './readers';
import type { AppActionResult, AppFormValues, StudioAppMeta, StudioAppRuntime } from '../model/types';

const path = (id: string) => `/api/studio-apps/${encodeURIComponent(id)}`;

/**
 * Apps the caller may open. Meta only — the component tree arrives from
 * /runtime, which is also where the audience gate is enforced.
 */
export async function listStudioApps(signal?: AbortSignal): Promise<StudioAppMeta[]> {
    const res = await api.get<unknown>('/api/studio-apps', { signal });
    return withId(field.list(readStudioApp)(pick(res, 'apps')));
}

/**
 * The run view. A non-owner always gets the frozen published copy; an
 * unpublished app answers 404 for them, which is a visibility answer and not
 * an error to apologise for. With `draft`, the OWNER gets the saved working
 * draft (the server ignores it for anyone else, who gets the published copy)
 * — what Studio opens, since the app you last edited is usually yours and
 * often not published yet.
 */
export async function getAppRuntime(
    id: string,
    signal?: AbortSignal,
    draft = false,
): Promise<StudioAppRuntime | null> {
    const query = draft ? { draft: '1' } : undefined;
    return nullable(readAppRuntime)(await api.get<unknown>(`${path(id)}/runtime`, { signal, query }));
}

/**
 * Submit a form to one of the app's actions.
 *
 * Only `kind: 'run_automation'` actions are reachable here — the bridge 404s
 * anything else (routes/studioAppsRun.js), and the phone checks the kind up
 * front so a button that cannot work is disabled rather than failing on tap.
 *
 * Inputs are resolved SERVER-SIDE from the action's own `inputMapping`; the
 * form values below only flow through `field` mappings, and only as
 * primitives. Answers 200 with the final output, 202 `{ runId, status:
 * 'pending' }` past the 60s wait, or `{ status: 'skipped' }` when the routine
 * was already running.
 *
 * `draft` goes with every run made from a draft runtime (getAppRuntime's
 * `draft`): the server resolves the action from the PUBLISHED definition
 * unless the owner sends `?draft=1`, so without it a draft's button answers
 * 404 on an unpublished app, or runs the published action. The server ignores
 * it for anyone but the owner.
 */
export async function runAppAction(
    appId: string,
    actionId: string,
    formValues: AppFormValues,
    draft = false,
): Promise<AppActionResult | null> {
    return nullable(readAppActionResult)(
        await api.post<unknown>(
            `${path(appId)}/actions/${encodeURIComponent(actionId)}/run`,
            { formValues },
            { timeoutMs: 70_000, retry: false, query: draft ? { draft: '1' } : undefined },
        ),
    );
}

/** Poll a 202'd app action. Same body as the synchronous answer. */
export async function getAppActionRun(
    appId: string,
    runId: string,
    signal?: AbortSignal,
): Promise<AppActionResult | null> {
    return nullable(readAppActionResult)(
        await api.get<unknown>(`${path(appId)}/actions/runs/${encodeURIComponent(runId)}`, { signal }),
    );
}
