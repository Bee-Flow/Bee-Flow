// @typecheck strict
// The one outward edge of the user create / delete code to Stripe, behind a port.
// users.js installs the real function at load; usersCreate.js and usersDelete.js
// only call it. They must not require the billing services themselves: those
// require the user store back, and every module that did would join that import
// cycle (scripts/scc-ratchet.mjs).

/** @type {(orgId: string) => Promise<unknown>} */
let sync = async () => undefined;

/** @param {(orgId: string) => Promise<unknown>} fn */
function setSeatSync(fn) { sync = fn; }

/**
 * Per-seat plans rebill on a user-count change; the caller decides whether to await.
 * @param {string} orgId
 */
function syncSeatQuantity(orgId) { return sync(orgId); }

module.exports = { setSeatSync, syncSeatQuantity };
