/**
 * call_action in the browser: run another action of the app as a subroutine.
 *
 * The called action's steps run in a child state: `params` are resolved in the
 * CALLER's scope (a records/aggregate binding works as for a loop source), and
 * item/index/value are not inherited. Its vars writes, its last server result and
 * any automation effects carry back; its own action-level onSuccess/onError are
 * not applied. A `return` step ends the called action only (`exec` is the
 * coordinator's action-level walk) and a loop around the call is not one a
 * `break` inside it can leave. A server step inside it posts to the ROOT action's URL with the
 * callPath (the ordinal of each call_action from the root), so the server keeps
 * the role gate and the public surface on the action that was clicked.
 *
 * Refused before any request: a missing action, more than MAX_CALL_DEPTH calls,
 * or a call back into an action already on the chain.
 */
import { resolveBinding } from '../resolveBinding';
import type { BindingInput } from '../resolveBinding.types';
import { buildStepIndexMap, mergeAppEffects, normalizeSequence } from './core';
import type { RunStep } from './core';
import type { ClientStepEnv } from './clientSteps';
import type { SeqState } from './serverSteps';
import { MAX_CALL_DEPTH, ownActionOf, usesRegistryKind } from './stepWalk';

/** The part of the sequence env a call reads and passes on to the called action's steps. */
export interface CallEnv extends ClientStepEnv {
    indexMap: Map<RunStep, number>;
    /** The actions on the call chain, root first. */
    callChain: string[];
    /** An action on the chain holds a step kind of the registry: server steps are posted with their kind. */
    echoKind?: boolean;
    /** Inside the steps of a loop or while of the same action (./controlFlow). */
    breakable?: boolean;
}

type ExecSteps<E extends CallEnv> = (env: E, list: unknown, st: SeqState) => Promise<void>;
type RecordResult<E extends CallEnv> = (env: E, step: RunStep, st: SeqState, result: unknown) => void;

function refusal(env: CallEnv, id: string, callee: RunStep | null): string | null {
    const { tr } = env.ctx;
    if (!callee) return tr('studio_apps_runtime.actions.call_missing', 'This step runs an action that no longer exists.');
    if (env.callChain.includes(id)) return tr('studio_apps_runtime.actions.call_cycle', 'An action cannot run itself, directly or through another action.');
    if (env.callChain.length > MAX_CALL_DEPTH) {
        return tr('studio_apps_runtime.actions.call_too_deep', 'Actions call each other more than {max} levels deep.', { max: MAX_CALL_DEPTH });
    }
    return null;
}

function resolveParams(env: CallEnv, raw: unknown, st: SeqState): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
    const bag = env.liveBag(st) as Parameters<typeof resolveBinding>[1];
    for (const [name, binding] of Object.entries(raw)) {
        out[name] = resolveBinding(binding as BindingInput, bag).value;
    }
    return out;
}

/** Runs `step` (a call_action) with `exec` walking the called action's steps. */
export async function runCallStep<E extends CallEnv>(env: E, step: RunStep, st: SeqState, exec: ExecSteps<E>, record: RecordResult<E>): Promise<void> {
    const id = typeof step.actionId === 'string' ? step.actionId : '';
    const callee = ownActionOf(env.ctx.live.current.definition?.actions, id);
    const refused = refusal(env, id, callee);
    if (refused) throw new Error(refused);

    const steps = normalizeSequence(callee);
    const ordinal = env.indexMap.get(step);
    const child: SeqState = {
        ...st,
        params: resolveParams(env, step.params, st),
        item: undefined,
        index: undefined,
        value: undefined,
        lastResult: undefined,
        appEffects: null,
        effectsUnknown: false,
        error: null,
        callPath: [...(st.callPath || []), typeof ordinal === 'number' ? ordinal : -1],
    };
    const childEnv: E = { ...env, indexMap: buildStepIndexMap(steps), callChain: [...env.callChain, id], breakable: false, echoKind: !!env.echoKind || usesRegistryKind(steps) };
    try {
        await exec(childEnv, steps, child);
    } finally {
        // vars are app state: what the called action wrote stays written.
        st.vars = child.vars;
        if (child.appEffects) st.appEffects = mergeAppEffects(st.appEffects, child.appEffects);
        if (child.effectsUnknown) st.effectsUnknown = true;
        if (child.error) st.error = child.error;
    }
    if (child.lastResult !== undefined) {
        record(env, step, st, child.lastResult);
    } else if (typeof step.resultVar === 'string' && step.resultVar) {
        st.vars = { ...st.vars, [step.resultVar]: null };
        env.ctx.setVar(step.resultVar, null);
    }
}
