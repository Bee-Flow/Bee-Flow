/**
 * The two ways a sequence step reaches the server: the plain JSON /step
 * dispatch, and ai_browse, which streams over its own SSE endpoint.
 */
import { actionsUrl, postJson } from '@/api/actionHttp';
import { parseSseStream } from '../sseStream';
import { BROWSE_STEP_DEADLINE_MS, STEP_DEADLINE_MS, quotaToast, readJson } from './core';
import type { EffectObject, Translate, Vars } from './core';
import type { RunnerContext } from './runnerContext';
import type { BrowseEvent } from '../BrowserRunContext';
import { errorName } from '@/utils/caughtError';
import type { RunTrack } from './runEnd';

/**
 * A step the SERVER answered with a failure (ok:false, or a non-2xx status).
 * `retryable` says whether trying again can help (the server's flag; for a
 * bare status only a 5xx other than 501). A deadline abort or a network error
 * stays a plain Error: its outcome is unknown, so it is never retried.
 */
export class StepFailure extends Error {
    code: string | null = null;
    retryable = false;
    status = 0;
    attempts = 1;
    /** The kind of the step that failed (error.step in a handler). */
    stepKind: string | null = null;
}

function stepFailure(message: string, init: { code?: unknown; retryable: boolean; status: number }): StepFailure {
    const f = new StepFailure(message);
    f.code = typeof init.code === 'string' && init.code ? init.code : null;
    f.retryable = init.retryable;
    f.status = init.status;
    return f;
}

/** The `error` a handler reads ({ message, step, code, attempts, stepIndex? }). */
export interface ErrorScope {
    message: string;
    step: string;
    code: string | null;
    attempts: number;
    stepIndex?: number;
}

/** A running sequence's state, threaded (and mutated) through its steps. */
export interface SeqState {
    actionId: string;
    formValues: Record<string, unknown>;
    vars: Vars;
    item: unknown;
    index: number | undefined;
    value: unknown;
    lastResult: unknown;
    appEffects: EffectObject | null | undefined;
    effectsUnknown?: boolean;
    error: string | null;
    /** Inside a called action: the params it reads as params.<name>. */
    params?: Record<string, unknown>;
    /** Inside a called action: the call_action ordinals from the root (actionId stays the ROOT). */
    callPath?: number[];
    /** Inside an onError handler: the failure it handles (scope root `error`, sent with each step). */
    errorScope?: ErrorScope | null;
    /** The run log's key of this click, shared by every copy of the state (./runEnd). */
    run?: RunTrack;
}

/** The body both step endpoints take: the ordinal plus the scope roots the server declares. */
function stepBody(stepIndex: number | undefined, st: SeqState): Record<string, unknown> {
    const body: Record<string, unknown> = { stepIndex, formValues: st.formValues || {}, vars: st.vars || {} };
    if (st.item !== undefined) body.item = st.item;
    // `index` is a declared server scope root and the loop tracks it,
    // but it was never put in the body: a create_record inside a loop
    // whose column read `index + 1` wrote NaN into every row, while the
    // loop itself iterated perfectly.
    if (st.index !== undefined) body.index = st.index;
    // `value` rides along like item/index — it too is a declared server
    // scope root that otherwise arrives undefined in every server step.
    if (st.value !== undefined) body.value = st.value;
    // A step inside a called action: the URL keeps the root action, the
    // server walks callPath to the step and reads params.<name>.
    if (st.callPath && st.callPath.length) body.callPath = st.callPath;
    if (st.params && Object.keys(st.params).length) body.params = st.params;
    // A server step inside an onError handler reads error.message / error.step.
    if (st.errorScope) body.error = st.errorScope;
    // The run log: every server step of one click carries the same run key.
    if (st.run) {
        body.runKey = st.run.runKey;
        st.run.serverSteps += 1;
    }
    return body;
}

/** POSTs a step, turning a deadline abort into the given readable error. */
async function postStep(url: string, body: Record<string, unknown>, deadlineMs: number, tooLong: () => string): Promise<Response> {
    try {
        return await postJson(url, body, deadlineMs);
    } catch (err) {
        const name = errorName(err);
        if (name === 'TimeoutError' || name === 'AbortError') throw new Error(tooLong());
        throw err;
    }
}

/**
 * A failed answer as a StepFailure: the real reason, the server's code, and
 * whether a retry can help (the server's flag; for a bare status only a 5xx
 * other than 501).
 */
function throwOnFailure(res: Response, payload: Record<string, unknown> | null, tr: Translate): void {
    // A quota rejection (409 body or ok:false step result) gets its
    // own actionable copy instead of the raw server error.
    if (payload?.code === 'quota_exceeded') throw stepFailure(quotaToast(tr), { code: 'quota_exceeded', retryable: false, status: res.status });
    if (!res.ok) {
        throw stepFailure((payload?.error as string) || tr('studio_apps_runtime.actions.step_failed_status', 'The step failed ({status})', { status: res.status }), {
            code: payload?.code, retryable: payload?.retryable === false ? false : res.status >= 500 && res.status !== 501, status: res.status,
        });
    }
    if (payload && payload.ok === false) {
        throw stepFailure((payload.error as string) || tr('studio_apps_runtime.actions.step_failed', 'The step failed.'), {
            code: payload.code, retryable: payload.retryable !== false, status: res.status,
        });
    }
}

export async function dispatchServerStep(ctx: RunnerContext, stepIndex: number | undefined, st: SeqState): Promise<unknown> {
    const { appId, draft, tr } = ctx;
    const qs = draft ? '?draft=1' : '';
    // The deadline is longer than the server's own AI ceiling, so its message
    // wins when it has one. This is the backstop for the case where it does
    // not: a provider adapter that ignores timeoutMs would otherwise leave
    // the spinner up forever.
    const res = await postStep(
        `${actionsUrl(appId)}/${encodeURIComponent(st.actionId)}/step${qs}`,
        stepBody(stepIndex, st),
        STEP_DEADLINE_MS,
        () => tr('studio_apps_runtime.actions.step_too_long', 'That took too long and was stopped. Try again, or with fewer documents.'),
    );
    const payload = await readJson(res);
    throwOnFailure(res, payload, tr);
    return payload && payload.result !== undefined ? payload.result : payload;
}

async function readBrowseStream(res: Response, actionId: string, publish: RunnerContext['live']['current']['onBrowseEvent'], tr: Translate): Promise<unknown> {
    let final: unknown = null;
    let failed: unknown = null;
    await parseSseStream(res, (raw) => {
        const evt = raw as BrowseEvent & Record<string, unknown>;
        if (evt.type === 'result') {
            if (evt.ok) final = evt.result || {};
            else failed = evt.error || tr('studio_apps_runtime.actions.browse_failed', 'The browse step failed.');
        } else if (evt.type !== 'done' && evt.type !== 'ping' && publish) {
            publish(actionId, evt);
        }
    });
    if (failed) throw new Error(failed as string);
    return final || {};
}

// ai_browse streams from its OWN endpoint: a browser agent runs
// server-side and pushes screenshot/action events, which we forward to
// the live-preview store. The resultVar is resolved from the terminal
// {type:'result'} frame, exactly like a plain /step result.
export async function dispatchBrowseStep(ctx: RunnerContext, stepIndex: number | undefined, st: SeqState): Promise<unknown> {
    const { appId, draft, tr } = ctx;
    const { actionId } = st;
    const body = stepBody(stepIndex, st);
    const qs = draft ? '?draft=1' : '';
    const publish = ctx.live.current.onBrowseEvent;
    if (publish) publish(actionId, { type: 'reset' });

    // Above the server's 240s hard cap, so a specific server error wins the
    // race over this generic backstop.
    const res = await postStep(
        `${actionsUrl(appId)}/${encodeURIComponent(actionId)}/step/stream${qs}`,
        body,
        BROWSE_STEP_DEADLINE_MS,
        () => tr('studio_apps_runtime.actions.browse_too_long', 'The browse took too long and was stopped.'),
    );
    if (!res.ok || !res.body) {
        const payload = await readJson(res);
        throw new Error((payload?.error as string) || tr('studio_apps_runtime.actions.browse_failed_status', 'The browse step failed ({status})', { status: res.status }));
    }
    return readBrowseStream(res, actionId, publish, tr);
}
