// @typecheck strict
// The one outward edge of the agent and skill stores to the GitHub sync
// service: with auto-sync on, a change is pushed (debounced). The service
// requires those stores back, so they must not require it themselves;
// boot/lateBoundPorts.js installs the real function and the stores only call it.

const log = require('../telemetry/log');

let warned = false;
/** @type {(orgId: string, resourceType: 'agent' | 'skill', resourceId: string, action?: string) => unknown} */
let push = () => {
    // Not silent: without the port an auto-synced organisation is not pushed.
    if (!warned) { warned = true; log.warn('[resourceSync] not installed: require boot/lateBoundPorts in this entry point; change not pushed to GitHub'); }
};

/** @param {(orgId: string, resourceType: 'agent' | 'skill', resourceId: string, action?: string) => unknown} fn */
function setAutoSyncResource(fn) { push = fn; }

/**
 * @param {string} orgId
 * @param {'agent' | 'skill'} resourceType
 * @param {string} resourceId
 * @param {string} [action]
 */
function autoSyncResource(orgId, resourceType, resourceId, action) { return push(orgId, resourceType, resourceId, action); }

module.exports = { setAutoSyncResource, autoSyncResource };
