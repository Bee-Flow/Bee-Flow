// @typecheck
/**
 * The two dependencies of the Stripe modules that sit inside the server's big
 * import cycle: configStore and userStore. services/stripeService.js is the
 * composition root and fills this in when it loads, so the modules under
 * stripe/ hold no static path back into that cycle (scc-ratchet).
 *
 * `userStore` is a getter so the store is still required lazily, at call time,
 * exactly like the inline `require('../stores/userStore')` it replaces.
 */

const deps = {
    /** @type {typeof import('../../stores/configStore') | null} */
    configStore: null,
    /** @type {(() => typeof import('../../stores/userStore')) | null} */
    userStore: null,
};

module.exports = deps;
