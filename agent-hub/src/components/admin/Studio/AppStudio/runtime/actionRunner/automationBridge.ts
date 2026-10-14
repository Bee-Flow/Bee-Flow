/**
 * The v1 run_automation bridge (unchanged behaviour): POST /run with
 * wait:true, poll a 202 until the run settles, then apply the authored
 * onSuccess effects merged with the automation's own _appEffects — or the
 * onError effects when it failed.
 */
import { API_BASE, authFetch } from '../../../../../../utils/helpers';
import {
    CANCELLED, POLL_INTERVAL_MS, POLL_TIMEOUT_MS, failureMessage, mergeAppEffects, readJson, showToast, sleep,
} from './core';
import type { RunOpts, RunnableAction } from './core';
import { actionsUrl } from './runnerContext';
import type { RunnerContext } from './runnerContext';

type RunBody = Record<string, unknown> | null;

async function pollRun(ctx: RunnerContext, runId: unknown): Promise<RunBody> {
    const { appId, tr } = ctx;
    const deadline = Date.now() + POLL_TIMEOUT_MS;
    while (Date.now() < deadline) {
        await sleep(POLL_INTERVAL_MS);
        if (!ctx.alive.current) throw CANCELLED;
        const res = await authFetch(
            `${API_BASE}${actionsUrl(appId)}/runs/${encodeURIComponent(String(runId))}`,
        );
        const body = await readJson(res);
        if (!res.ok) throw new Error((body?.error as string) || tr('studio_apps_runtime.actions.check_run_failed', 'Could not check the run ({status})', { status: res.status }));
        const status = body?.status as string | undefined;
        if (status && !['pending', 'running', 'queued'].includes(status)) return body;
    }
    throw new Error(tr('studio_apps_runtime.actions.run_too_long', 'The automation is taking too long — check its run history.'));
}

const resultOf = (body: RunBody): unknown => (body && body.result !== undefined ? body.result : body);

/**
 * Settles the POST's answer into the final run body. Returns 'pending' when
 * the run was accepted without a handle to poll: it keeps running server-side, so
 * the caller settles neutrally.
 */
async function settleRunResponse(ctx: RunnerContext, res: Response, initial: RunBody): Promise<RunBody | 'pending'> {
    const { tr } = ctx;
    let body = initial;
    if (res.status === 202) {
        const runId = body?.runId ?? body?.id;
        if (runId != null) {
            body = await pollRun(ctx, runId);
        } else if (body?.status === 'pending') {
            return 'pending';
        } else {
            throw new Error((body?.error as string) || (body?.message as string) || tr('studio_apps_runtime.actions.no_result', 'The action was accepted but never returned a result.'));
        }
    } else if (!res.ok) {
        throw new Error((body?.error as string) || (body?.message as string) || tr('studio_apps_runtime.actions.failed_status', 'The action failed ({status})', { status: res.status }));
    }
    if (body?.status === 'error') {
        throw new Error((body?.error as string) || tr('studio_apps_runtime.actions.failed', 'The action failed.'));
    }
    return body;
}

export async function runAutomationAction(ctx: RunnerContext, actionId: string, action: RunnableAction, opts: RunOpts): Promise<void> {
    const { appId, draft, tr, setEntry, applyEffects } = ctx;
    if (ctx.live.current.actionState[actionId]?.status === 'running') return;
    setEntry(actionId, { status: 'running', result: undefined, error: null });
    try {
        const qs = draft ? '?draft=1' : '';
        const res = await authFetch(
            `${API_BASE}${actionsUrl(appId)}/${encodeURIComponent(actionId)}/run${qs}`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ formValues: opts.formValues || {}, wait: true }),
            },
        );
        const body = await settleRunResponse(ctx, res, await readJson(res));
        if (body === 'pending') {
            // Accepted, but with no run id there is nothing to poll (a
            // GET on `undefined` would 404 and report a failure the user
            // never had). The automation keeps running server-side, so
            // settle neutrally: no error state, no success/error effects.
            setEntry(actionId, { status: 'idle', result: undefined, error: null });
            showToast('info', tr('studio_apps_runtime.actions.run_still_running', 'The automation is still running — check its run history.'));
            return;
        }
        if (body?.status === 'awaiting_approval') {
            // The automation paused on an approval step — working as designed,
            // not a success and certainly not a failure. Settle with the
            // handle (approvalId) but hold the onSuccess effects: nothing
            // has succeeded yet, someone still has to decide.
            setEntry(actionId, { status: 'success', result: resultOf(body), error: null });
            showToast('info', tr('studio_apps_runtime.actions.sent_for_approval', 'Sent for approval — it continues once someone decides.'));
            return;
        }
        setEntry(actionId, { status: 'success', result: resultOf(body), error: null });
        // `_appEffects` rides beside `output` on the run body — the same
        // field whether the run answered directly or through the poll, so
        // there is no second channel and nothing new to subscribe to.
        await applyEffects(mergeAppEffects(action.onSuccess, body?._appEffects), { formId: opts.formId, formName: opts.formName, effectsUnknown: !!body?._appEffectsUnknown });
    } catch (err) {
        if (err === CANCELLED || !ctx.alive.current) return;
        const message = failureMessage(err, tr);
        setEntry(actionId, { status: 'error', result: undefined, error: message });
        // A bare v1 run_automation set actionState.error and stopped there —
        // and no runtime component renders that, so a failed action was
        // completely invisible. The sequence path has always toasted; this
        // is the same promise for the older shape.
        showToast('danger', message);
        await applyEffects(action.onError, { formId: opts.formId, formName: opts.formName });
    }
}
