/**
 * Recursive step stripping, shared by the screen and the dialog clean-ups.
 *
 * definitionOps.js carries two copies of this walk (stripNavigateSteps and
 * stripModalSteps) that differ only in which step they drop; here it is one
 * walk with a predicate. It recurses the same branch bodies canonicalize.js
 * walks server-side: condition then/else, loop steps, switch cases and default.
 * Unchanged lists come back by reference.
 */

import type { ActionStep } from '../types';
import { isRecord } from './ids';

const BRANCH_KEYS = ['then', 'else', 'steps', 'default'] as const;

function stripCases(cases: unknown[], drop: (step: ActionStep) => boolean): unknown[] | null {
    let dirty = false;
    const next = cases.map((c) => {
        if (!c || typeof c !== 'object') return c;
        const steps = (c as { steps?: unknown }).steps;
        const branch = stripSteps(steps, drop);
        if (branch === steps) return c;
        dirty = true;
        return { ...(c as object), steps: branch };
    });
    return dirty ? next : null;
}

function stripOne(step: ActionStep, drop: (step: ActionStep) => boolean): ActionStep {
    let copy = step;
    for (const key of BRANCH_KEYS) {
        const branch = stripSteps(step[key], drop);
        if (branch !== step[key]) copy = { ...copy, [key]: branch };
    }
    if (Array.isArray(step.cases)) {
        const cases = stripCases(step.cases, drop);
        if (cases) copy = { ...copy, cases };
    }
    return copy;
}

/** Drop every step `drop` names, at any depth. Non-arrays pass through. */
export function stripSteps<T>(steps: T, drop: (step: ActionStep) => boolean): T {
    if (!Array.isArray(steps)) return steps;
    let dirty = false;
    const next: unknown[] = [];
    for (const step of steps as unknown[]) {
        if (!step || typeof step !== 'object') {
            next.push(step);
            continue;
        }
        const s = step as ActionStep;
        if (drop(s)) {
            dirty = true;
            continue;
        }
        const copy = stripOne(s, drop);
        if (copy !== s) dirty = true;
        next.push(copy);
    }
    return (dirty ? next : steps) as T;
}

/** A map of actions with `fn` applied to each; the same map back when nothing changed. */
export function mapActions<A>(actions: Record<string, A> | undefined, fn: (action: A) => A): Record<string, A> | undefined {
    let dirty = false;
    const next: Record<string, A> = {};
    for (const [id, action] of Object.entries(actions || {})) {
        const copy = isRecord(action) ? fn(action) : action;
        if (copy !== action) dirty = true;
        next[id] = copy;
    }
    return dirty ? next : actions;
}
