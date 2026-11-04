import type { Step } from './definitionOps.types';

/**
 * Every child list of a sequence step mapped with `map`: the branch bodies
 * (condition then/else, loop/transaction steps, switch cases and default) and
 * the step's onError handler (`{ steps }`). The step is copied only when one of
 * them changed, so an untouched tree comes back by reference — the same walk
 * canonicalize does server-side, shared by the screen and dialog clean-ups.
 */
export function mapStepBranches(step: Step, map: (list: Step[] | undefined) => Step[] | undefined): Step {
    let copy = step;
    for (const key of ['then', 'else', 'steps', 'default'] as const) {
        const branch = map(step[key]);
        if (branch !== step[key]) copy = { ...copy, [key]: branch };
    }
    if (Array.isArray(step.cases)) {
        let casesDirty = false;
        const cases = step.cases.map((c: { steps?: Step[] }) => {
            if (!c || typeof c !== 'object') return c;
            const branch = map(c.steps);
            if (branch === c.steps) return c;
            casesDirty = true;
            return { ...c, steps: branch };
        });
        if (casesDirty) copy = { ...copy, cases };
    }
    const h = (step as { onError?: unknown }).onError;
    if (h && typeof h === 'object' && !Array.isArray(h) && Array.isArray((h as { steps?: unknown }).steps)) {
        const steps = (h as { steps: Step[] }).steps;
        const branch = map(steps);
        if (branch !== steps) copy = { ...copy, onError: { ...(h as Record<string, unknown>), steps: branch } } as Step;
    }
    return copy;
}
