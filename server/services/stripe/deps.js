// @typecheck strict
/**
 * The two dependencies of the Stripe modules that sit inside the server's big
 * import cycle: configStore and userStore. services/stripeService.js is the
 * composition root and fills this in when it loads, so the modules under
 * stripe/ hold no static path back into that cycle (scc-ratchet).
 *
 * `userStore` is a getter so the store is still required lazily, at call time,
 * exactly like the inline `require('../stores/userStore')` it replaces.
 */

// Typed as filled: stripeService.js sets both when it loads, before any Stripe module is called.
const deps = {
    configStore: /** @type {typeof import('../../stores/configStore')} */ (/** @type {unknown} */ (null)),
    userStore: /** @type {() => typeof import('../../stores/userStore')} */ (/** @type {unknown} */ (null)),
};

module.exports = deps;
