// @typecheck strict
'use strict';

/**
 * Input the caller got wrong (a type, a channel, a status, a date): a route
 * answers 400 with the message. Everything else a store throws is a fault and
 * reaches the terminal handler as a 500 with a correlation id.
 */
class StoreInputError extends Error {
    /** @param {string} message */
    constructor(message) { super(message); this.name = 'StoreInputError'; this.code = 'invalid_input'; }
}

module.exports = { StoreInputError };
