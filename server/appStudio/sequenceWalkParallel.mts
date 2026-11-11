/**
 * The `parallel` step kind for the server walker (sequenceWalk.mts): the branches of the step
 * run side by side, the walk goes on when all of them ended. The browser coordinator does the
 * same in agent-hub runtime/actionRunner/parallelStep.ts; the rules both follow are in
 * shared/appDefinition/parallelRules.mjs.
 *
 * The walk state is one mutable object, so every branch walks a FORK of it (forkState):
 *   private  vars (a copy), item, index, value, params, error, lastResult, failed, stopped,
 *            truncated, signal, callChain
 *   shared   outcomes, known, notes, deferred (the same objects) and `executed` (the fork
 *            reads and writes the parent's count, so a step budget counts every branch)
 *
 * The join, when every branch ended:
 *   vars        the writes of the branches, applied in branch order (mergeBranchVars)
 *   lastResult  that of the last branch, in branch order, that produced one
 *   how it ended, by precedence: a budget stop in any branch (the walk is truncated), else the
 *               first branch in order that failed (its failure is the walk's: an enclosing try
 *               catches it), else the first branch a handler ended quietly
 *
 * `failFast: true`: once a branch stopped, the other branches end before their next step and
 * branches not yet started do not start. A budget stop does that whatever `failFast` says.
 * The stop reaches a branch through its host's shouldStop, so it is treated like a budget stop
 * inside that branch (a try does not catch it and its `finally` does not run).
 *
 * At most STUDIO_APP_PARALLEL_MAX branches run at once (default 4, 0 = unlimited). A host with
 * `sequentialBranches` (the dry run) walks them one after another and says so in a note.
 *
 * A branch frame is marked `parallel: 'branch'`; walkStep refuses the kinds that may not run
 * there (parallelRules.parallelRefusal) and break/continue cannot reach a loop around the step.
 */

import { MAX_PARALLEL_BRANCHES, mergeBranchVars, runPool } from '../shared/appDefinition/parallelRules.mjs';
import type { Frame } from './sequenceWalk.mts';
import type { FlowApi } from './sequenceWalkFlow.mts';
import type { Obj, Step, StepEvent, WalkHost, WalkState } from './sequenceWalkTypes.mts';

const DEFAULT_PARALLEL_MAX = 4;
/** `stopped` of a branch that was ended because another branch stopped. */
const ENDED_WITH_SIBLING = 'another branch of the parallel step stopped';

const isObject = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v);

/** How many branches run at once: STUDIO_APP_PARALLEL_MAX, a whole number from 0 (unlimited) up; 4 when unset or not one. */
export function parallelMax(raw: string | undefined = process.env.STUDIO_APP_PARALLEL_MAX): number {
    if (raw === undefined || raw.trim() === '') return DEFAULT_PARALLEL_MAX;
    const n = Number(raw);
    return Number.isInteger(n) && n >= 0 ? n : DEFAULT_PARALLEL_MAX;
}

/** A branch's own walk state (the header says what is private and what is shared). */
export function forkState(w: WalkState): WalkState {
    const fork: WalkState = { ...w, vars: { ...w.vars }, stopped: null, truncated: false, signal: null };
    Object.defineProperty(fork, 'executed', {
        get: () => w.executed,
        set: (n: number) => { w.executed = n; },
        enumerable: true, configurable: true,
    });
    return fork;
}

type Branches = {
    forks: WalkState[];
    started: boolean[];
    /** A branch stopped and the others must end. */
    halted: boolean;
    /** What a host threw out of a branch (the walk itself never throws). */
    thrown: { error: unknown } | null;
};

/** The host a branch walks with: the same one, whose shouldStop also answers when the branches were halted. */
function branchHost(host: WalkHost, run: Branches): WalkHost {
    return { ...host, shouldStop: (bw) => (run.halted ? ENDED_WITH_SIBLING : host.shouldStop ? host.shouldStop(bw) : null) };
}

const endedWithSibling = (bw: WalkState): boolean => bw.stopped === ENDED_WITH_SIBLING;

/** Walks branch `k` on its fork. Never rejects: a throw of the host is kept for after the join. */
async function walkBranch(api: FlowApi, inner: Frame, run: Branches, k: number, steps: unknown, base: string, failFast: boolean): Promise<void> {
    if (run.halted) return;
    run.started[k] = true;
    const bw = run.forks[k];
    try {
        await api.walkList({ ...inner, w: bw }, steps, base);
    } catch (error) {
        run.thrown = run.thrown ?? { error };
        run.halted = true;
        return;
    }
    if (bw.stopped && !endedWithSibling(bw) && (failFast || bw.truncated)) run.halted = true;
}

/** The fork that decides how the step ended, or null when every branch ran to its end. */
function decidingFork(ran: WalkState[], before: WalkState['failed']): WalkState | null {
    const stops = ran.filter((bw) => bw.stopped && !endedWithSibling(bw));
    return stops.find((bw) => bw.truncated)
        ?? stops.find((bw) => bw.failed && bw.failed !== before)
        ?? stops[0]
        ?? null;
}

/** Puts what the branches did back on the walk state. Returns the indexes of the branches that failed. */
function join(w: WalkState, run: Branches): number[] {
    const before = { failed: w.failed, lastResult: w.lastResult };
    const ran = run.forks.filter((_, k) => run.started[k]);
    w.vars = mergeBranchVars(w.vars, run.forks.map((bw, k) => (run.started[k] ? bw.vars : null))).vars;
    for (const bw of ran) if (bw.lastResult !== before.lastResult) w.lastResult = bw.lastResult;
    const failed = run.forks.flatMap((bw, k) => (run.started[k] && bw.failed && bw.failed !== before.failed ? [k] : []));
    const decides = decidingFork(ran, before.failed);
    if (decides) {
        w.stopped = decides.stopped;
        w.truncated = decides.truncated;
    }
    // A failure that did not stop its branch (a set_variable without a name) still marks the walk.
    const failure = decides?.failed && decides.failed !== before.failed ? decides.failed : failed.length ? run.forks[failed[0]].failed : null;
    if (failure) w.failed = failure;
    return failed;
}

/** Walks one `parallel` step. */
export async function walkParallel(api: FlowApi, fr: Frame, step: Step, ev: StepEvent, startedAt: number): Promise<void> {
    const { w, host } = fr;
    // A branch cannot pause (the walker refuses it), so a resumed walk never comes back through here.
    if (w.resume) return api.lost(fr, ev, startedAt);
    const branches = Array.isArray(step.branches) ? step.branches : [];
    if (branches.length > MAX_PARALLEL_BRANCHES) {
        return api.fail(fr, ev, { error: `A parallel step holds at most ${MAX_PARALLEL_BRANCHES} branches; this one has ${branches.length}`, code: 'parallel_too_many' }, startedAt);
    }
    const sequential = typeof host.sequentialBranches === 'string' && host.sequentialBranches !== '';
    const run: Branches = { forks: branches.map(() => forkState(w)), started: branches.map(() => false), halted: false, thrown: null };
    const inner: Frame = { ...fr, host: branchHost(host, run), depth: fr.depth + 1, breakable: false, parallel: 'branch' };
    const failFast = step.failFast === true;
    await runPool(branches.length, sequential ? 1 : parallelMax(), (k) => {
        const branch = branches[k];
        return walkBranch(api, inner, run, k, isObject(branch) ? branch.steps : [], `${ev.path}.branches[${k}].steps`, failFast);
    });
    const failed = join(w, run);
    if (sequential && branches.length > 1) api.addNote(w, `${ev.path}: ${host.sequentialBranches}`);
    await api.record(fr, ev, { status: 'ok', result: { branches: branches.length, ...(failed.length ? { failed } : {}) } }, startedAt);
    if (run.thrown) throw run.thrown.error;
}
