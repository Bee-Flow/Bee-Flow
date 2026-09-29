/**
 * Module lifecycle audit — a NEVER-THROW wrapper over the host's existing
 * access_audit_log (userStore.logAccessAudit) with target_type
 * 'platform_module'. No new tables; payloads are status/version/permission
 * METADATA only — never tokens, secrets or grant bodies.
 *
 * Events: platform.module.install | update | quarantine | reactivate |
 * selfheal | consent | entitlement_flip | install_revoked (plus the
 * pre-existing platform.module.import/remove written directly by
 * modules/index.js — those strings are unchanged).
 */

'use strict';
const log = require('../telemetry/log');

let _userStore;
function userStore() { return _userStore || (_userStore = require('../stores/userStore')); }

/**
 * @param {string} action    e.g. 'platform.module.selfheal'
 * @param {string} moduleId
 * @param {string|null} actorId  null for system-initiated events
 * @param {object} [meta]    after-image metadata (status/version/etc.)
 * @param {object} [before]  optional before-image
 */
async function emit(action, moduleId, actorId = null, meta = {}, before = null) {
    try {
        await userStore().logAccessAudit(action, 'platform_module', moduleId, actorId, before, meta || {}, null);
    } catch (e) {
        log.warn(`[ModuleAudit] ${action} audit failed for ${moduleId}:`, e.message);
    }
}

module.exports = { emit };
