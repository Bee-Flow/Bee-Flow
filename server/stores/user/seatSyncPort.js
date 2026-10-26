// @typecheck
// The one outward edge of the user create / delete code to Stripe, behind a port.
// boot/lateBoundPorts.js installs the real function (the server loads it at boot;
// a script that changes users or organisations requires it too); usersCreate.js,
// usersDelete.js and users.js only call it. They must not require the billing services themselves: those
// require the user store back, and every module that did would join that import
// cycle (scripts/scc-ratchet.mjs).

const log = require('../../telemetry/log');

let warned = false;
/** @type {(orgId: string) => Promise<unknown>} */
let sync = async () => {
    // Not silent: a process that changes seats without the port installed would
    // leave the Stripe seat count wrong.
    if (!warned) { warned = true; log.warn('[seatSync] not installed: require boot/lateBoundPorts in this entry point; Stripe seat quantity not synced'); }
};

/** @param {(orgId: string) => Promise<unknown>} fn */
function setSeatSync(fn) { sync = fn; }

/** Per-seat plans rebill on a user-count change; the caller decides whether to await. */
function syncSeatQuantity(orgId) { return sync(orgId); }

module.exports = { setSeatSync, syncSeatQuantity };
