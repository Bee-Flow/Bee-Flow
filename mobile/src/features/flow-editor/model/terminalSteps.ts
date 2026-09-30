/**
 * Step types after which NOTHING runs — the phone's copy of the server's
 * `TERMINAL_STEP_TYPES` (server/automation/validate/constants.js), via the
 * web builder's flow/terminalSteps.js. terminalSteps.lockstep.test.ts reads
 * the server list and fails when they drift.
 *
 * The editor needs this in several gestures: no "+" after such a step, no
 * variables from its output, no connection drawn out of it. `layer_output`
 * shares the `end` family but is NOT terminal: a flowlet returns to its
 * caller, and the caller carries on.
 */

export const TERMINAL_STEP_TYPES: ReadonlySet<string> = new Set([
    // Halts the run with an error message.
    'stop_error',
    // Ends the run and hands the Studio App that started it what to do next.
    'return_to_app',
]);

/** Is this the type of a step after which nothing runs? False for nullish. */
export function isTerminalStepType(type: unknown): boolean {
    return typeof type === 'string' && TERMINAL_STEP_TYPES.has(type);
}

/** Convenience for call sites that hold the step itself. */
export function isTerminalStep(step: { type?: unknown } | null | undefined): boolean {
    return isTerminalStepType(step && step.type);
}
