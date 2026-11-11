/**
 * App Studio validator: the `parallel` step kind.
 *
 *   validateStepBranches  the shape of `branches` (a list of 1 to MAX_PARALLEL_BRANCHES
 *                         objects `{ steps }`) and the steps of every branch
 *   checkParallel         what may not sit inside a branch, directly or through a
 *                         call_action (parallelRules.parallelRefusal): the error
 *                         `action.step_in_parallel`; and the warning
 *                         `action.parallel_same_variable` when two branches write the
 *                         same variable (the later branch wins at the join)
 *
 * The runners refuse the same steps when they meet them (sequenceWalk.mts, the browser's
 * parallelStep.ts), so a definition that was never validated cannot run them either.
 * This file never imports validate.js.
 */

import { createRequire } from 'node:module';
import type * as ActionCalls from '../actionCalls.mts';
import type * as StepFlow from '../../shared/appDefinition/stepFlow.mjs';
import type * as ParallelRules from '../../shared/appDefinition/parallelRules.mjs';

const nodeRequire = createRequire(import.meta.url);
// Required, not imported: agent-hub's typecheck reaches this file through validate.js,
// and its tsconfig refuses a `.mts` import path (the other validate/*.mts do the same).
const { someStepThroughCalls } = nodeRequire('../actionCalls.mts') as typeof ActionCalls;
const { childStepSlots } = nodeRequire('../../shared/appDefinition/stepFlow.mjs') as typeof StepFlow;
const { MAX_PARALLEL_BRANCHES, parallelRefusal } = nodeRequire('../../shared/appDefinition/parallelRules.mjs') as typeof ParallelRules;
const { stepMetaOf } = nodeRequire('../componentSpecs/stepRegistry.js') as {
    stepMetaOf: (kind: unknown) => { writesVars?: readonly { field: string; loop?: boolean }[] } | null;
};

type Obj = Record<string, unknown>;
type Finding = { code: string; severity: string; path: string; message: string; hint: string };
type Ctx = { pushE: (f: Finding) => void; pushW: (f: Finding) => void; actions?: Obj | null };

/** Hand-written definitions can nest without end; the scans stop here (the validator reports the depth itself). */
const MAX_SCAN_DEPTH = 24;

const isObject = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v);

/** `branches` of a parallel step: the list itself, then the steps of every branch through `walk`. */
export function validateStepBranches(value: unknown, path: string, walk: (steps: unknown, at: string) => void, ctx: Ctx): void {
    const shape = 'Use [{ steps: [...] }, { steps: [...] }].';
    if (!Array.isArray(value)) {
        ctx.pushE({ code: 'action.step_field_invalid', severity: 'error', path, message: 'parallel `branches` must be an array.', hint: shape });
        return;
    }
    if (!value.length || value.length > MAX_PARALLEL_BRANCHES) {
        ctx.pushE({
            code: 'action.parallel_branch_count', severity: 'error', path,
            message: `A parallel step holds 1 to ${MAX_PARALLEL_BRANCHES} branches (LIMITS.MAX_PARALLEL_BRANCHES); this one has ${value.length}.`,
            hint: value.length ? 'Merge branches, or run the rest in a second parallel step after this one.' : shape,
        });
    }
    value.forEach((branch, i) => {
        if (!isObject(branch)) {
            ctx.pushE({ code: 'action.step_field_invalid', severity: 'error', path: `${path}[${i}]`, message: 'Each branch must be an object { steps }.', hint: shape });
            return;
        }
        walk(branch.steps, `${path}[${i}].steps`);
    });
}

/** The first step under `list` (the branch's own action only) that satisfies `pred`. */
function findOwn(list: unknown, pred: (step: Obj) => boolean, depth = 1): Obj | null {
    if (!Array.isArray(list) || depth > MAX_SCAN_DEPTH) return null;
    for (const step of list) {
        if (!isObject(step)) continue;
        if (pred(step)) return step;
        for (const slot of childStepSlots(step)) {
            const hit = findOwn(slot.steps, pred, depth + 1);
            if (hit) return hit;
        }
    }
    return null;
}

/** The step kinds under a branch that may not run there, in first-seen order: its own steps, then through calls. */
function refusedKinds(steps: unknown, actions: unknown): string[] {
    const kinds = new Set<string>();
    if (findOwn(steps, (s) => parallelRefusal(s.kind, true) === 'return')) kinds.add('return');
    someStepThroughCalls(steps, actions, (s) => {
        if (parallelRefusal(s.kind, false)) kinds.add(String(s.kind));
        return false;
    });
    return [...kinds];
}

const REFUSAL_HINTS: Readonly<Record<string, string>> = Object.freeze({
    return: 'A return could only end this one branch. Move it after the parallel step, or put the branch in its own action and run that with call_action.',
    parallel: 'Add its branches to this parallel step instead (up to LIMITS.MAX_PARALLEL_BRANCHES).',
    send_email: 'Send the message once, before or after the parallel step.',
    transaction: 'Run the transaction before or after the parallel step: it must be the only writer while it runs.',
});
const REFUSAL_HINT = 'Move it before or after the parallel step: it takes over the page, or waits on a person, while the other branches are still running.';

/** The variables the steps of one branch write (resultVar, set_variable and the catalogue's writesVars), through calls. */
function writtenVars(steps: unknown, actions: unknown): Set<string> {
    const names = new Set<string>();
    someStepThroughCalls(steps, actions, (s) => {
        if (typeof s.resultVar === 'string' && s.resultVar) names.add(s.resultVar);
        for (const w of stepMetaOf(s.kind)?.writesVars ?? []) {
            const name = s[w.field];
            // A loop's itemVar and indexVar are restored after the loop: not a write that reaches the join.
            if (!w.loop && typeof name === 'string' && name) names.add(name);
        }
        return false;
    });
    return names;
}

function checkSharedVars(branches: unknown[], path: string, ctx: Ctx): void {
    const firstWriter = new Map<string, number>();
    const told = new Set<string>();
    branches.forEach((branch, k) => {
        if (!isObject(branch)) return;
        for (const name of writtenVars(branch.steps, ctx.actions)) {
            const first = firstWriter.get(name);
            if (first === undefined) { firstWriter.set(name, k); continue; }
            if (told.has(name)) continue;
            told.add(name);
            ctx.pushW({
                code: 'action.parallel_same_variable', severity: 'warning', path: `${path}.branches[${k}].steps`,
                message: `Branches ${first + 1} and ${k + 1} of this parallel step both write the variable "${name}".`,
                hint: 'The branches do not see each other\'s writes, and after the step the value of the later branch stands. Give each branch its own variable name.',
            });
        }
    });
}

/** parallel: what a branch may hold, and two branches writing one variable. */
export function checkParallel(step: Obj, path: string, ctx: Ctx): void {
    const branches = Array.isArray(step.branches) ? step.branches : [];
    branches.forEach((branch, k) => {
        if (!isObject(branch)) return;
        for (const kind of refusedKinds(branch.steps, ctx.actions)) {
            ctx.pushE({
                code: 'action.step_in_parallel', severity: 'error', path: `${path}.branches[${k}].steps`,
                message: kind === 'return'
                    ? 'A "return" step may not sit directly in a branch of a parallel step.'
                    : `A "${kind}" step may not run inside a branch of a parallel step, also not in an action the branch calls.`,
                hint: Object.hasOwn(REFUSAL_HINTS, kind) ? REFUSAL_HINTS[kind] : REFUSAL_HINT,
            });
        }
    });
    checkSharedVars(branches, path, ctx);
}
