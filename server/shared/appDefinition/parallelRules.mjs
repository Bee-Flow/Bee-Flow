// @typecheck strict
/**
 * App Studio — the rules of a `parallel` step, in ONE place. Pure, no imports:
 * the server walker (appStudio/sequenceWalkParallel.mts), the browser coordinator
 * (agent-hub runtime/actionRunner/parallelStep.ts) and the validator
 * (appStudio/validate/parallelChecks.mts) all read them here, so a branch means
 * the same thing wherever the action runs.
 *
 *   - what may not run inside a branch (parallelRefusal);
 *   - how the variables the branches wrote come together at the join
 *     (mergeBranchVars: in branch order, so the result never depends on which
 *     branch happened to finish first);
 *   - how many branches run at once (runPool).
 */

/** Branches one `parallel` step may hold. */
export const MAX_PARALLEL_BRANCHES = 8;

/**
 * Step kinds that never run inside a branch, also not in an action a branch
 * calls: they take over the page (navigate, confirm, open_modal), must be the
 * only writer (transaction), reach people (send_email), wait on a person
 * (await_approval), or would multiply the branches (a parallel inside a parallel).
 */
export const PARALLEL_FORBIDDEN_KINDS = Object.freeze(['navigate', 'confirm', 'open_modal', 'transaction', 'send_email', 'await_approval', 'parallel']);

/**
 * Why a step of `kind` may not run inside a branch, or null when it may.
 *   'kind'    one of PARALLEL_FORBIDDEN_KINDS (anywhere under the branch, called actions included)
 *   'return'  a return in the branch's own action: it could only end one branch, not the action
 *             (in an action the branch CALLS a return is fine: it ends that action)
 *
 * @param {unknown} kind
 * @param {boolean} ownAction  the step sits in the action that holds the parallel step
 * @returns {'kind' | 'return' | null}
 */
export function parallelRefusal(kind, ownAction) {
    if (typeof kind !== 'string') return null;
    if (PARALLEL_FORBIDDEN_KINDS.includes(kind)) return 'kind';
    return ownAction && kind === 'return' ? 'return' : null;
}

/**
 * The variables after the join. `base` is what they were when the branches
 * started; `branches` holds, per branch in definition order, the variables that
 * branch ended with (null for a branch that never started). A name counts as
 * written by a branch when its value there is not the one it started with.
 * Writes are applied in branch order: when two branches wrote the same name,
 * the later branch's value stands.
 *
 * @param {Record<string, unknown>} base
 * @param {readonly (Record<string, unknown> | null | undefined)[]} branches
 * @returns {{ vars: Record<string, unknown>, written: string[] }}
 */
export function mergeBranchVars(base, branches) {
    /** @type {Record<string, unknown>} */
    const vars = { ...base };
    /** @type {Set<string>} */
    const written = new Set();
    for (const own of branches) {
        if (!own || typeof own !== 'object') continue;
        for (const name of Object.keys(own)) {
            if (Object.hasOwn(base, name) && own[name] === base[name]) continue;
            vars[name] = own[name];
            written.add(name);
        }
    }
    return { vars, written: [...written] };
}

/**
 * Runs `runOne(0) … runOne(count - 1)`, at most `max` at a time (0 or less: all
 * at once), each started in index order. `runOne` must not reject: a branch
 * reports how it ended through its own state.
 *
 * @param {number} count
 * @param {number} max
 * @param {(index: number) => Promise<void>} runOne
 * @returns {Promise<void>}
 */
export async function runPool(count, max, runOne) {
    const lanes = max > 0 ? Math.min(max, count) : count;
    let next = 0;
    const lane = async () => {
        while (next < count) {
            const index = next;
            next += 1;
            await runOne(index);
        }
    };
    await Promise.all(Array.from({ length: lanes }, lane));
}
