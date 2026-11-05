// @typecheck strict
/**
 * Who caused the App Studio AI calls in flight, and in which run.
 *
 * An app runs as its OWNER (the owner's models, the owner's budget), so every
 * ledger row of an app carries the owner as `user_id`. The person who clicked
 * the button is a different person, and without this the usage ledger could
 * not say who uses an app. The runner that knows the viewer (a click route, a
 * background job) runs the step inside `withUsageAttribution`; aiRuntime's
 * usage entry reads it back as `actor_user_id` and `run_id`. Outside such a
 * scope both are null, which the ledger reads as "same as user_id".
 *
 * Held in AsyncLocalStorage so no executor signature changes (the pattern of
 * runLog/runTrace.mts). A leaf: it requires nothing local.
 */

'use strict';

const { AsyncLocalStorage } = require('node:async_hooks');

/** @typedef {{ actorUserId?: string | null, runId?: string | null }} UsageAttribution */

/** @type {AsyncLocalStorage<UsageAttribution>} */
const storage = new AsyncLocalStorage();

/**
 * Run `fn` with the actor and run of its AI calls.
 * @template T
 * @param {UsageAttribution} attribution
 * @param {() => T} fn
 * @returns {T}
 */
function withUsageAttribution(attribution, fn) {
    return storage.run({ actorUserId: attribution.actorUserId ?? null, runId: attribution.runId ?? null }, fn);
}

/**
 * The ledger fields of the scope in flight (both null outside one).
 * @returns {{ actor_user_id: string | null, run_id: string | null }}
 */
function usageAttributionFields() {
    const current = storage.getStore();
    return { actor_user_id: current?.actorUserId ?? null, run_id: current?.runId ?? null };
}

module.exports = { withUsageAttribution, usageAttributionFields };
