/**
 * What the upstream describers need from the client they run in.
 *
 * The describers are pure, but a few facts live in client modules that have
 * their own owners and drift tests: the Set step's column operations, the
 * Date & time step's list mode, the form-pick registry the server sends, the
 * terminal step types, and the words a group is called in the client's
 * language. Each client passes them in once (agent-hub
 * Builder/mapping/upstream.ts, mobile bindings/upstream/index.ts); the
 * defaults here are what a client without them gets: English group names,
 * no terminal types, rows left as they are.
 *
 *   label(key, fallback, vars)   a group's name. `key` names it, `fallback`
 *                                is the English with `{var}` slots.
 *                                Keys: `node.<type>` (a step type's default
 *                                name), `set`, `route`, `form_page`, and the
 *                                group names (`trigger_info`, `loop_named`, …).
 */

const fill = (text, vars) => String(text).replace(/\{(\w+)\}/g, (m, k) => (vars && vars[k] !== undefined ? String(vars[k]) : m));

export const DEFAULT_ENV = Object.freeze({
    label: (key, fallback, vars) => fill(fallback, vars),
    isTerminalStepType: () => false,
    /** The form-pick registry entry for an id: `{ app, sampleData }`, or null. */
    pickSourceById: () => null,
    /** The Set step's operations folded over one sample row. */
    applyOpsToSampleRow: (row) => row,
    /** The column a list-mode Date & time step writes. */
    datetimeTargetColumn: (step) => String(step?.target || step?.op || 'value'),
    /** The list mode a Date & time step implies without an `arrayRef`, or null. */
    impliedListMode: () => null,
    isDateTimeListMode: (step) => typeof step?.arrayRef === 'string',
    /** The time stamped on the trigger's `firedAt` sample. */
    now: () => new Date(),
});

/** The env with every hook present; idempotent. */
export function resolveEnv(env) {
    if (env && env.__resolved === true) return env;
    return Object.freeze({ ...DEFAULT_ENV, ...(env || {}), __resolved: true });
}

/** A group's name through the env. */
export function groupLabel(env, key, fallback, vars) {
    return resolveEnv(env).label(key, fallback, vars);
}
