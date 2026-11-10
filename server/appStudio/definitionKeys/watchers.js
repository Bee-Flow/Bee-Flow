// @typecheck strict
/**
 * definition.watchers (schema 3): run an action each time the value of a formula changes.
 *
 *   [{ id, expr, actionId, debounceMs? }]
 *
 * The browser evaluates every watcher against the live scope of the run (vars, forms,
 * screen, records, …). The first value is only remembered; each later CHANGE of the value
 * runs the action once, after `debounceMs` of quiet when it is set. A watcher that runs
 * more than WATCHER_MAX_RUNS_PER_MINUTE times in a minute is switched off for the rest of
 * the visit and says so. Never in the editor or a screenshot.
 *
 * A public page gets only the watchers whose action the public screens already run
 * (`publicValue`): a watcher can never make another action reachable.
 */

'use strict';

const { cleanWatchers } = require('../canonicalize/clientTriggers');
const { LIMITS } = require('../componentSpecs/limits');
const { WATCHER_MAX_RUNS_PER_MINUTE } = require('../../shared/appDefinition/clientTriggers.mjs');

/**
 * @param {unknown} value
 * @param {(code: string, path: string, message: string) => void} push
 * @param {{ renameMap: unknown, actionIds?: Set<string> }} ctx
 */
function canon(value, push, ctx) {
    const list = cleanWatchers(value, push);
    if (!list) return undefined;
    const renames = ctx.renameMap instanceof Map ? ctx.renameMap : new Map();
    const kept = list.filter((watcher, i) => {
        const id = String(watcher.actionId);
        watcher.actionId = renames.get(id) || id;
        if (!ctx.actionIds || ctx.actionIds.has(String(watcher.actionId))) return true;
        push('event.dangling', `watchers[${i}].actionId`, `A watcher referenced unknown action "${id}" — the watcher was removed.`);
        return false;
    });
    return kept.length ? kept : undefined;
}

/**
 * @param {unknown} value
 * @param {{ def: Record<string, unknown>, pushE: (f: object) => void, pushW: (f: object) => void }} ctx
 */
function validate(value, ctx) {
    require('../validate/clientTriggerChecks.mts').validateWatchers(value, ctx);
}

/**
 * What a public page receives: the watchers whose action is one the public screens run.
 * @param {unknown} value
 * @param {{ actionIds?: Set<string> }} surface
 */
function publicValue(value, surface) {
    const ids = surface && surface.actionIds;
    if (!Array.isArray(value) || !(ids instanceof Set)) return undefined;
    const kept = value.filter((w) => w && typeof w === 'object' && ids.has(/** @type {{ actionId?: string }} */ (w).actionId || ''));
    return kept.length ? kept : undefined;
}

module.exports = {
    key: 'watchers',
    since: 3,
    public: true,
    canon,
    validate,
    publicValue,
    shape: `[{ id, expr, actionId, debounceMs? }] (max ${LIMITS.MAX_WATCHERS})`,
    description: 'Watchers run an action each time the value of a formula changes. '
        + 'expr is a formula without the {kind} wrapper, for example "vars.status" or "count(forms.cmp_order.items)", '
        + 'read against the same scope as a visibleWhen. The first value is only remembered: each later change runs actionId once. '
        + `debounceMs (0 to ${LIMITS.MAX_WATCHER_DEBOUNCE_MS}) waits for that much quiet first, which suits a value someone is still typing. `
        + `A watcher that runs more than ${WATCHER_MAX_RUNS_PER_MINUTE} times in a minute is switched off for the rest of the visit, `
        + 'so never let the action change the value it watches. Watchers run in the live app only (never in the editor or a screenshot); '
        + 'on a public page only for actions the public screens already run. '
        + 'Prefer a formula binding when the goal is only to SHOW a derived value: a watcher is for doing something (set_variable, refresh, a server step). '
        + 'There is no dedicated tool yet: the person adds watchers in the Logic tab of the editor.',
};
