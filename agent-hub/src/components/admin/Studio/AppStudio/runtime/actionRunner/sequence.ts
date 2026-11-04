/**
 * The v2 sequence coordinator: walks a { kind:'sequence', steps } action step
 * by step. Server kinds go through ./serverSteps, client kinds through
 * ./clientSteps, and condition/switch/loop recurse here against the live
 * scope.
 *
 * Error handling (stepFlow.mjs owns the shapes): a server step with `retry`
 * is tried again while the server says retrying can help (never after a
 * deadline abort or a network error: the outcome is unknown). A failing step
 * with `onError: { steps, stop? }` runs those steps with `error` in scope and
 * the sequence CONTINUES (`stop: true`, and the legacy array form, end it
 * quietly); no toast, the run settles as a success. Without a handler the
 * failure aborts the sequence as before.
 */
import { tryEvaluate } from '@shared/expr/engine.mjs';
import { clampErrorScope, errorHandlerOf, retryPlanOf } from '@shared/appDefinition/stepFlow.mjs';
import { resolveBinding } from '../resolveBinding';
import { buildScope } from '../RuntimeContext';
import { runClientStep } from './clientSteps';
import type { ClientStepEnv, LiveBag } from './clientSteps';
import {
    CANCELLED, MAX_LOOP_ITERATIONS, SEQ_ABORT, SERVER_STEP_KINDS, buildStepIndexMap, caseMatches, failureMessage,
    mergeAppEffects, normalizeSequence, sequenceHasServerStep, showToast, sleep,
} from './core';
import type { RunOpts, RunStep, RunnableAction } from './core';
import type { RunnerContext } from './runnerContext';
import { StepFailure, dispatchBrowseStep, dispatchServerStep } from './serverSteps';
import type { ErrorScope, SeqState } from './serverSteps';
import { runCallStep } from './callStep';
import { newRunTrack, reportRunEnd } from './runEnd';

interface SeqEnv extends ClientStepEnv {
    actionId: string;
    indexMap: Map<RunStep, number>;
    hasServer: boolean;
    /** call_action: the actions on the chain, root first. */
    callChain: string[];
}

// The FULL bag resolveBinding takes ({ actionState, dataState, scope }) —
// identical to the one the renderer builds. A scope-only bag makes every
// record/records/dataset/connector/actionResult source resolve to
// undefined (a loop over a table would run zero iterations).
function makeLiveBag(ctx: RunnerContext, actionId: string): LiveBag {
    return (st) => {
        const live = ctx.live.current;
        const merged = { ...live.actionState };
        if (st.lastResult !== undefined) {
            merged[actionId] = { status: 'running', result: st.lastResult, error: null };
        }
        const data = live.dataState || {};
        return {
            actionState: merged,
            dataState: data,
            scope: buildScope({
                actionState: merged,
                dataState: data,
                form: st.formValues || {},
                // `forms` and `screen` are in every scope the RENDERER
                // builds, so a formula that reads screen.params.<name> —
                // which is how every template passes a record id to a detail
                // screen — worked in a binding and resolved to undefined in
                // the step that acted on it.
                forms: live.forms || {},
                screen: live.screen || {},
                vars: st.vars || {},
                item: st.item,
                index: st.index,
                value: st.value,
                params: st.params || {},
                error: (st.errorScope as Record<string, unknown> | null | undefined) || null,
                currentUser: live.currentUser || null,
            }),
        };
    };
}

/** Threads a server step's result into lastResult, resultVar and the control's spinner. */
function recordServerResult(env: SeqEnv, step: RunStep, st: SeqState, result: unknown): void {
    st.lastResult = result;
    // A transaction hands back the resultVars of its children: later steps read them as vars.<name>.
    if (step.kind === 'transaction' && result && typeof result === 'object') {
        const named = (result as { vars?: unknown }).vars;
        if (named && typeof named === 'object' && !Array.isArray(named)) {
            for (const [name, value] of Object.entries(named)) {
                st.vars = { ...st.vars, [name]: value };
                env.ctx.setVar(name, value);
            }
        }
    }
    if (typeof step.resultVar === 'string' && step.resultVar) {
        st.vars = { ...st.vars, [step.resultVar]: result };
        env.ctx.setVar(step.resultVar, result); // persist beyond this sequence
    }
    if (env.hasServer) env.ctx.setEntry(env.actionId, { status: 'running', result, error: null });
}

/**
 * One server step, tried again per its `retry` while the server says it can
 * help. Each attempt is its own POST (charged by the step limiters). The
 * failure that ends it carries the attempts made and the step's kind.
 */
async function dispatchWithRetry(env: SeqEnv, step: RunStep, st: SeqState): Promise<unknown> {
    const plan = retryPlanOf(step);
    for (let attempt = 1; ; attempt++) {
        try {
            return await dispatchServerStep(env.ctx, env.indexMap.get(step), st);
        } catch (e) {
            const again = e instanceof StepFailure && e.retryable && attempt <= plan.times;
            if (e instanceof StepFailure) {
                e.attempts = attempt;
                e.stepKind = e.stepKind || String(step.kind);
            }
            if (!again) throw e;
            if (plan.delayMs > 0) await sleep(plan.delayMs);
            if (!env.ctx.alive.current) throw CANCELLED;
        }
    }
}

async function runServerStep(env: SeqEnv, step: RunStep, st: SeqState): Promise<void> {
    const result = await dispatchWithRetry(env, step, st);
    if (result && typeof result === 'object') {
        const effects = result as { _appEffects?: unknown; _appEffectsUnknown?: unknown };
        // A run_automation STEP carries the automation's return the same
        // way the bare v1 action does. Held until the sequence is done
        // rather than applied here: navigating away halfway would abort
        // the steps that still had to run.
        if (effects._appEffects) st.appEffects = mergeAppEffects(st.appEffects, effects._appEffects);
        // See applyEffects: unreadable is not the same as empty. One step
        // that could not read it colours the whole sequence, because that
        // step's instructions really are gone.
        if (effects._appEffectsUnknown) st.effectsUnknown = true;
    }
    recordServerResult(env, step, st, result);
}

async function runLoop(env: SeqEnv, step: RunStep, st: SeqState): Promise<void> {
    const { value: src } = resolveBinding(step.source, env.liveBag(st));
    const arr: unknown[] = Array.isArray(src) ? src : [];
    const cap = Number.isInteger(step.maxIterations)
        ? Math.min(step.maxIterations as number, MAX_LOOP_ITERATIONS) : MAX_LOOP_ITERATIONS;
    for (let i = 0; i < arr.length && i < cap; i++) {
        const outerVars = st.vars || {};
        const iter: SeqState = {
            ...st,
            item: arr[i],
            index: i,
            vars: {
                ...outerVars,
                ...(step.itemVar ? { [step.itemVar as string]: arr[i] } : {}),
                ...(step.indexVar ? { [step.indexVar as string]: i } : {}),
            },
        };
        await execSteps(env, step.steps, iter);
        // itemVar/indexVar are ITERATION-scoped: whatever the name
        // held outside the loop is restored, so later steps never
        // see it pinned to the last row. Other writes carry on.
        const carried = { ...iter.vars };
        for (const name of [step.itemVar, step.indexVar]) {
            if (typeof name !== 'string' || !name) continue;
            if (Object.prototype.hasOwnProperty.call(outerVars, name)) carried[name] = outerVars[name];
            else delete carried[name];
        }
        st.vars = carried;
        st.lastResult = iter.lastResult;
        // Same reason lastResult is carried back: an iteration
        // is a copy of the state, so an automation's return picked
        // up inside the body would otherwise be dropped.
        if (iter.appEffects) st.appEffects = mergeAppEffects(st.appEffects, iter.appEffects);
        if (iter.effectsUnknown) st.effectsUnknown = true;
    }
}

async function runControlStep(env: SeqEnv, step: RunStep, st: SeqState): Promise<void> {
    switch (step.kind) {
        case 'condition': {
            const { value } = tryEvaluate(step.expr, env.liveBag(st).scope);
            await execSteps(env, value ? step.then : step.else, st);
            return;
        }
        case 'switch': {
            const { value } = tryEvaluate(step.expr, env.liveBag(st).scope);
            const cases: unknown[] = Array.isArray(step.cases) ? step.cases : [];
            const hit = cases.find((c) => c && caseMatches((c as { value?: unknown }).value, value)) as { steps?: unknown } | undefined;
            await execSteps(env, hit ? hit.steps : step.default, st);
            return;
        }
        case 'loop':
            await runLoop(env, step, st);
            return;
        default:
            return;
    }
}

async function execStep(env: SeqEnv, step: RunStep | null | undefined, st: SeqState): Promise<void> {
    if (!step || typeof step.kind !== 'string') return;
    // ai_browse is a SERVER kind but streams — it takes the dedicated
    // SSE path, not the plain JSON /step dispatch below.
    if (step.kind === 'ai_browse') {
        recordServerResult(env, step, st, await dispatchBrowseStep(env.ctx, env.indexMap.get(step), st));
        return;
    }
    // Server kinds are dispatched from the SET, not from a hand-written
    // case list. The list-and-set used to be maintained separately and
    // drifted (send_email), which turns a step into a silent no-op
    // instead of an error. Driving both off one value makes that class
    // of bug unrepresentable.
    if (SERVER_STEP_KINDS.has(step.kind)) {
        await runServerStep(env, step, st);
        return;
    }
    // Another action as a subroutine (./callStep): its steps run through this coordinator.
    if (step.kind === 'call_action') {
        await runCallStep(env, step, st, execSteps, recordServerResult);
        return;
    }
    if (await runClientStep(env, step, st)) return;
    await runControlStep(env, step, st);
}

/** The `error` scope for a handler of `step`'s failure `e`. */
function errorScopeFor(env: SeqEnv, step: RunStep, e: unknown): ErrorScope {
    const failure = e instanceof StepFailure ? e : null;
    return clampErrorScope({
        message: failureMessage(e, env.ctx.tr),
        step: failure?.stepKind || String(step.kind),
        code: failure?.code ?? null,
        attempts: failure?.attempts ?? 1,
        stepIndex: env.indexMap.get(step),
    }) as ErrorScope;
}

/**
 * A step failed. With an onError handler: run it with `error` in scope, then
 * continue (or end quietly with `stop`). Without one: record the reason and
 * rethrow, as before. A failure inside the handler propagates like any other.
 */
async function handleStepFailure(env: SeqEnv, step: RunStep | null | undefined, e: unknown, st: SeqState): Promise<void> {
    const handler = errorHandlerOf(step);
    if (!step || !handler) {
        st.error = failureMessage(e, env.ctx.tr);
        throw e;
    }
    const saved = st.errorScope;
    st.errorScope = errorScopeFor(env, step, e);
    st.error = null;
    if (st.run) st.run.handled = true;
    try {
        await execSteps(env, handler.steps, st);
    } finally {
        st.errorScope = saved;
    }
    if (handler.stop) throw SEQ_ABORT;
}

async function execSteps(env: SeqEnv, list: unknown, st: SeqState): Promise<void> {
    for (const raw of (Array.isArray(list) ? list : [])) {
        const step = raw as RunStep | null | undefined;
        if (!env.ctx.alive.current) throw CANCELLED;
        try {
            await execStep(env, step, st);
        } catch (e) {
            if (e === SEQ_ABORT || e === CANCELLED) throw e;
            await handleStepFailure(env, step, e, st);
        }
    }
}

function initialState(ctx: RunnerContext, actionId: string, opts: RunOpts): SeqState {
    return {
        actionId,
        formValues: opts.formValues || {},
        vars: { ...ctx.live.current.vars },
        // The ROW that triggered this, when one did. A row click hands the
        // row over, and the inspector's own picker (and every template)
        // teaches `item.<field>` for it — so without this, "open THIS
        // ticket" resolved to undefined and the next screen opened blank.
        // A loop step overwrites both for the duration of its body.
        item: opts.item,
        index: opts.index,
        // The VALUE beside the row, when the trigger carries one — a kanban
        // drop's target column, an onChange's new value. `value` has been a
        // declared scope root on both sides all along, but nothing ever put
        // the payload's value into it, so `expr: 'value'` always read
        // undefined while `form.value` worked.
        value: opts.value,
        lastResult: undefined,
        // What a return_to_app step handed back, collected across the whole
        // sequence and applied once at the end.
        appEffects: null,
        error: null,
    };
}

/**
 * Only a server-touching sequence shows the triggering control's spinner
 * (and guards re-entry). Pure client sequences run synchronously. False when
 * the run must not start.
 */
async function prepareServerRun(ctx: RunnerContext, actionId: string): Promise<boolean> {
    if (ctx.live.current.actionState[actionId]?.status === 'running') return false;
    const beforeServerStep = ctx.live.current.beforeServerStep;
    if (beforeServerStep) {
        // The server resolves the step from the definition IT has; make
        // sure that is the one on screen before handing it an ordinal.
        const ready = await beforeServerStep();
        if (ready && ready.ok === false) {
            showToast('danger', ready.error || ctx.tr('studio_apps_runtime.actions.not_saved', 'Your latest changes could not be saved, so this was not run.'));
            return false;
        }
    }
    ctx.setEntry(actionId, { status: 'running', result: undefined, error: null });
    return true;
}

type RunOutcome = 'success' | 'error' | 'cancelled' | 'aborted';

/**
 * The run log of this click (./runEnd): one run key for every server step, and the one end report
 * when it settles. `aborted` (a declined confirm or onError stop) ends as success when a handler
 * dealt with a failure, else as cancelled.
 */
function runEnder(ctx: RunnerContext, actionId: string, state: SeqState, hasServer: boolean): (outcome: RunOutcome, error?: string | null) => void {
    if (hasServer) state.run = newRunTrack();
    return (outcome, error) => {
        const status = outcome === 'aborted' ? (state.run?.handled ? 'success' : 'cancelled') : outcome;
        void reportRunEnd(ctx.appId, actionId, !!ctx.draft, state.run, { status, error });
    };
}

export async function runSequence(ctx: RunnerContext, actionId: string, action: RunnableAction, opts: RunOpts): Promise<void> {
    const steps = normalizeSequence(action);
    // Follows call_action, so a server step inside a called action shows the spinner too.
    const hasServer = sequenceHasServerStep(steps, ctx.live.current.definition?.actions);
    if (hasServer && !(await prepareServerRun(ctx, actionId))) return;

    const env: SeqEnv = { ctx, actionId, hasServer, indexMap: buildStepIndexMap(steps), liveBag: makeLiveBag(ctx, actionId), callChain: [actionId] };
    const state = initialState(ctx, actionId, opts);
    const end = runEnder(ctx, actionId, state, hasServer);
    const { setEntry, applyEffects } = ctx;
    try {
        await execSteps(env, steps, state);
        end('success');
        if (hasServer) setEntry(actionId, { status: 'success', result: state.lastResult, error: null });
        await applyEffects(mergeAppEffects(action.onSuccess, state.appEffects), { formId: opts.formId, formName: opts.formName, effectsUnknown: !!state.effectsUnknown });
    } catch (e) {
        if (e === SEQ_ABORT) {
            end('aborted');
            // Declined confirm / handled onError — settle without an error.
            if (hasServer) {
                setEntry(actionId, state.lastResult !== undefined
                    ? { status: 'success', result: state.lastResult, error: null }
                    : { status: 'idle', result: undefined, error: null });
            }
            return;
        }
        if (e === CANCELLED || !ctx.alive.current) { end('cancelled'); return; }
        const message = state.error || failureMessage(e, ctx.tr);
        end('error', message);
        // A server-touching sequence surfaces the error on the triggering
        // control (status:'error'); every failed sequence also toasts so the
        // abort is never silent. onError effects (if any) apply afterwards.
        if (hasServer) setEntry(actionId, { status: 'error', result: undefined, error: message });
        showToast('danger', message);
        await applyEffects(action.onError, { formId: opts.formId, formName: opts.formName });
    }
}
