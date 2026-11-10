/**
 * The `parallel` step kind in the browser: the branches of the step run side
 * by side, the sequence goes on when all of them ended. The server walker does
 * the same in server/appStudio/sequenceWalkParallel.mts; the rules both follow
 * are in @shared/appDefinition/parallelRules.mjs.
 *
 * Every branch runs on a COPY of the sequence state: its own variables, last
 * result and collected effects. A server step inside a branch is still one POST
 * by its ordinal, with the variables of its own branch.
 *
 * The join, when every branch ended:
 *   vars        the writes of the branches, applied in branch order, and stored
 *               again in that order (a branch stores its writes the moment it
 *               makes them, so without this the last one to FINISH would stand)
 *   lastResult  that of the last branch, in branch order, that produced one
 *   effects     what the branches' automations handed back, merged in order
 *   how it ended: the first branch in order that failed fails the step (an
 *               enclosing try catches it), else the first branch a handler
 *               ended quietly ends the sequence quietly
 *
 * `failFast: true`: once a branch stopped, the other branches end before their
 * next step (they see the page as gone: nothing more runs in them, a `finally`
 * included) and branches not yet started do not start.
 *
 * At most BROWSER_PARALLEL_MAX branches run at once. A branch env is marked
 * `parallel: 'branch'`; the coordinator refuses the kinds that may not run
 * there (refuseInBranch) and break/continue cannot reach a loop around the step.
 */
import { MAX_PARALLEL_BRANCHES, mergeBranchVars, parallelRefusal, runPool } from '@shared/appDefinition/parallelRules.mjs';
import { CANCELLED, SEQ_ABORT, mergeAppEffects } from './core';
import type { RunStep } from './core';
import type { ClientStepEnv } from './clientSteps';
import { StepFailure } from './serverSteps';
import type { SeqState } from './serverSteps';

/** Branches that run at once in the browser (the server's own cap is STUDIO_APP_PARALLEL_MAX). */
export const BROWSER_PARALLEL_MAX = 4;

/** The part of the sequence env a parallel step reads and hands to its branches. */
export interface ParallelEnv extends ClientStepEnv {
    /** Inside the steps of a loop or while of the same action (./controlFlow). */
    breakable?: boolean;
    /** Under a branch of a parallel step: in the action that holds it (`branch`) or in one it calls (`called`). */
    parallel?: 'branch' | 'called';
}

type ExecSteps<E extends ParallelEnv> = (env: E, list: unknown, st: SeqState) => Promise<void>;

function failure(message: string, code: string, kind: string): StepFailure {
    const f = new StepFailure(message);
    f.code = code;
    f.stepKind = kind;
    return f;
}

/** Throws when `step` may not run under a branch of a parallel step. A no-op outside one. */
export function refuseInBranch(env: ParallelEnv, step: RunStep): void {
    if (!env.parallel || !parallelRefusal(step.kind, env.parallel === 'branch')) return;
    const kind = String(step.kind);
    throw failure(env.ctx.tr('studio_apps_flow_parallel.runtime.not_in_parallel', 'A {kind} step cannot run inside a branch of a parallel step.', { kind }), 'not_in_parallel', kind);
}

/** How one branch ended: its state, and what it threw (ENDED when it ran to its end). */
interface BranchEnd { st: SeqState; thrown: unknown }
const ENDED = Symbol('actionRunner.branchEnded');

/** Puts what the branches did back on the state around the step. */
function join(env: ParallelEnv, st: SeqState, base: Record<string, unknown>, ends: Array<BranchEnd | null>): void {
    const merged = mergeBranchVars(base, ends.map((end) => (end ? end.st.vars : null)));
    st.vars = merged.vars;
    for (const name of merged.written) env.ctx.setVar(name, merged.vars[name]);
    const before = st.lastResult;
    for (const end of ends) {
        if (!end) continue;
        if (end.st.lastResult !== before) st.lastResult = end.st.lastResult;
        if (end.st.appEffects) st.appEffects = mergeAppEffects(st.appEffects, end.st.appEffects);
        if (end.st.effectsUnknown) st.effectsUnknown = true;
    }
}

/** Runs `step` (a parallel) with `exec` walking the steps of each branch. */
export async function runParallel<E extends ParallelEnv>(env: E, step: RunStep, st: SeqState, exec: ExecSteps<E>): Promise<void> {
    const branches: unknown[] = Array.isArray(step.branches) ? step.branches : [];
    if (branches.length > MAX_PARALLEL_BRANCHES) {
        throw failure(env.ctx.tr('studio_apps_flow_parallel.runtime.too_many', 'A parallel step holds at most {max} branches.', { max: MAX_PARALLEL_BRANCHES }), 'parallel_too_many', 'parallel');
    }
    const page = env.ctx.alive;
    const run = { halted: false };
    // A halted branch sees the page as gone: the coordinator ends it before its next step.
    const alive = { get current() { return page.current && !run.halted; } };
    const inner: E = { ...env, ctx: { ...env.ctx, alive }, breakable: false, parallel: 'branch' };
    const base = st.vars || {};
    const failFast = step.failFast === true;
    const ends: Array<BranchEnd | null> = branches.map(() => null);

    await runPool(branches.length, BROWSER_PARALLEL_MAX, async (k) => {
        if (!alive.current) return;
        const fork: SeqState = { ...st, vars: { ...base }, appEffects: null, effectsUnknown: false, error: null };
        const branch = branches[k] as { steps?: unknown } | null;
        let thrown: unknown = ENDED;
        try {
            await exec(inner, branch && typeof branch === 'object' ? branch.steps : [], fork);
        } catch (e) {
            thrown = e;
        }
        ends[k] = { st: fork, thrown };
        if (thrown !== ENDED && thrown !== CANCELLED && failFast) run.halted = true;
    });

    join(env, st, base, ends);
    if (!page.current) throw CANCELLED;
    // A branch that was halted, or that saw the page go, did not fail.
    const stops = ends.filter((end): end is BranchEnd => !!end && end.thrown !== ENDED && end.thrown !== CANCELLED);
    const failed = stops.find((end) => end.thrown !== SEQ_ABORT);
    if (failed) {
        st.error = failed.st.error;
        throw failed.thrown;
    }
    if (stops.length) throw SEQ_ABORT;
}
