/**
 * THE TERMINAL STEP TYPES: the canvas mirror of one server list.
 *
 * Step types after which NOTHING runs. The canvas has to know this in five separate gestures,
 * and each of them USED to know it as a hand-written `type === 'stop_error'`:
 *
 *   1. mapping/upstream.js          no variable group: nothing can bind to the output of a terminal
 *   2. flow/useStepDrop.js          dropping a step after it is refused
 *   3. flow/nodeDropTarget.js       dragging a step next to it does not chain onto it
 *   4. flow/useEdgeEditCallbacks.js drawing an edge by hand is refused
 *   5. flow/nodes/<X>Node.jsx       no "+" button and `sourceConnectable={false}`
 *
 * Five literals means five places that can drift apart, and the sixth (the validator, on the
 * server side) lives in another language in another directory. That is precisely where the risk
 * lies: if the canvas does not know a type as terminal, it invites you to stick steps after the
 * end step, which never run, and the validator says nothing about it. Or the other way round: the
 * validator refuses a graph that the editor has just let it draw.
 *
 * THE SOURCE IS THE SERVER. `TERMINAL_STEP_TYPES` in `server/automation/validate/constants.js` is
 * the canonical list. This is the copy that the browser can read (no module crosses the
 * server/agent-hub boundary). The drift test beside it, `terminalSteps.test.js`, reads the server
 * list from the source and fails as soon as the two diverge, AND as soon as a step type with
 * family `end` arrives that is in neither list and has no explicit exception either.
 *
 * THIS IS NOT PRESENTATION. That is why it lives here and not in nodeDefs.js, which says itself:
 * "if the runner or the validator must read it, it does not belong here". The VISUAL family (`end`)
 * and the terminal RULE are two different things, and `layer_output` is the living proof: family
 * `end`, but connectable, because a flowlet returns to its caller, and that one carries on.
 */

export const TERMINAL_STEP_TYPES: ReadonlySet<string> = new Set([
    // Halts the run with an error message.
    'stop_error',
    // Ends the run and hands the Studio App that started it what to do next.
    'return_to_app',
]);

/**
 * Is this the type of a step after which nothing runs?
 *
 * Takes the TYPE, not the step, so a caller that only has a type string does
 * not have to fabricate an object — and answers false for null/undefined so a
 * lookup that missed narrows to "not terminal, keep the normal rules" rather
 * than throwing inside a drag handler.
 */
export function isTerminalStepType(type?: unknown): boolean {
    return typeof type === 'string' && TERMINAL_STEP_TYPES.has(type);
}

/** Convenience for the call sites that hold the step object itself. */
export function isTerminalStep(step?: { type?: unknown } | null): boolean {
    return isTerminalStepType(step && step.type);
}
