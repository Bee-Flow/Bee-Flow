// @typecheck strict
'use strict';

/**
 * The result check for the four writers that answer instead of throwing when
 * the database refuses them: `setOrgSubscription`, `setConsumerSubscription`
 * and `updatePlan` answer `false`, `createPlan` answers `null` (the store has
 * already logged the database error).
 *
 *   assertStored(await userStore.setOrgSubscription(orgId, data), `subscription of organization ${orgId}`);
 *
 * A caller that carries on after such an answer reports work that did not
 * happen. The throw is a plain Error: in a route the terminal handler turns it
 * into a generic 500, in a Stripe webhook it releases the event for redelivery.
 * `what` goes into the log: name the row by its id, never by a person.
 */
class StoreWriteError extends Error {
    /** @param {string} what */
    constructor(what) {
        super(`${what} was not stored`);
        this.name = 'StoreWriteError';
        this.code = 'store_write_failed';
    }
}

/**
 * @template T
 * @param {T} result  what the store answered
 * @param {string} what  the row that was to be written, by id
 * @returns {T}
 */
function assertStored(result, what) {
    if (result === false || result === null) throw new StoreWriteError(what);
    return result;
}

module.exports = { assertStored, StoreWriteError };
