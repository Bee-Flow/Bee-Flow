// @typecheck strict
/**
 * App Studio — where a sequence step holds other steps. Pure, imports nothing.
 *
 * Every static walker (validators, the call-graph helpers) and the server
 * sequence walker (appStudio/sequenceWalk.mts) read the child places of a step
 * from here, so a new place (a handler, a transaction body) is added once and
 * every reader sees it.
 *
 *   condition → `.then`, `.else`
 *   loop      → `.steps`
 *   switch    → `.cases[k].steps` per case (k = the index in `cases`), then `.default`
 *
 * `suffix` is the walker path segment the child list hangs under (the step's
 * own path + suffix + `[i]`). `walked: true` means the server walker visits the
 * list as steps; every slot here is walked.
 *
 * flattenSteps (appStudio/actionSequence.js) deliberately does NOT use this: the
 * mobile lockstep test lifts that function by its own source text, so it stays
 * self-contained. Its order (then, else / steps / cases, default) is the order
 * of the slots below.
 *
 * Server-only until the editor imports it (scripts/shared-mirror.manifest.json
 * excludes it from the agent-hub copy).
 */

/**
 * @typedef {{ suffix: string, steps: unknown[], walked: boolean }} StepSlot
 */

/** @param {unknown} v @returns {unknown[]} */
const listOf = (v) => (Array.isArray(v) ? v : []);

/**
 * The places `step` holds child steps, in pre-order.
 *
 * @param {unknown} step
 * @returns {StepSlot[]}
 */
export function childStepSlots(step) {
    if (!step || typeof step !== 'object' || Array.isArray(step)) return [];
    const s = /** @type {Record<string, unknown>} */ (step);
    if (s.kind === 'condition') {
        return [
            { suffix: '.then', steps: listOf(s.then), walked: true },
            { suffix: '.else', steps: listOf(s.else), walked: true },
        ];
    }
    if (s.kind === 'loop') return [{ suffix: '.steps', steps: listOf(s.steps), walked: true }];
    if (s.kind === 'switch') {
        /** @type {StepSlot[]} */
        const out = listOf(s.cases).map((c, k) => ({
            suffix: `.cases[${k}].steps`,
            steps: c && typeof c === 'object' ? listOf(/** @type {Record<string, unknown>} */ (c).steps) : [],
            walked: true,
        }));
        out.push({ suffix: '.default', steps: listOf(s.default), walked: true });
        return out;
    }
    return [];
}

/**
 * Every child list of `step`, walked or not: what a static check reads.
 *
 * @param {unknown} step
 * @returns {unknown[][]}
 */
export function childStepLists(step) {
    return childStepSlots(step).map((s) => s.steps);
}
