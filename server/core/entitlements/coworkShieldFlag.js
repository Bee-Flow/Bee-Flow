/**
 * CW-10 — per-org flag: privacy shield on the NON-AGENT run path.
 *
 * Today only the agent runtime (chatWithAgent/chatStream) applies the org
 * privacy shield. The plain Cowork/Routines path — aiTaskRunner.executeTask
 * for tasks without an agent — calls the model adapter directly, unshielded,
 * while the UI is about to grow a "Privacy shield on" pill next to those very
 * runs. This flag is the org-level opt-in that lets the runner make that
 * claim true.
 *
 * This module owns ONLY the flag (per the contextPolicy.js idiom):
 *
 *   - stored under `org_cowork_shield_<orgId>` in configStore;
 *   - MISSING or malformed normalises to OFF. Default-off is load-bearing:
 *     the path is shared with existing Routines, so an existing org's
 *     scheduled runs must keep doing exactly what they do today, and after a
 *     rollback there is no admin-visible "shield on" that old code silently
 *     stops enforcing. Existing orgs are additionally stamped explicitly off
 *     by migrations/cowork-shield-flag-2026-09.js;
 *   - never throws: a config-store failure reads as OFF. That is fail-safe
 *     here because the flag only decides whether the shield APPLIES to this
 *     path (config, mirrored by the UI pill — no pill claims protection while
 *     the flag is unreadable). Once the flag is ON, the shield's own
 *     failure semantics take over and those stay fail-CLOSED: the consumer
 *     must reuse the agent runtime's degradation/failmode rules
 *     (core/privacy/piiDetection — block on degraded guard per piiFailureMode),
 *     never "shield unavailable ⇒ run unshielded".
 *
 * The consumer (executeTask's non-agent path + the effective state on the
 * Cowork API) lands separately; nothing in this release reads the flag into
 * behaviour yet. Turning it ON for new orgs is an explicit write at
 * org-creation time that ships together with the write UI — NOT a reader
 * default, which must stay off for the rollback story above.
 */

const configStore = require('../../stores/configStore');
const log = require('../../telemetry/log');

const CONFIG_KEY_PREFIX = 'org_cowork_shield_';
const CACHE_TTL_MS = 30_000;

const DEFAULT_FLAG = Object.freeze({ enabled: false, configured: false });

const _cache = new Map(); // orgId → { at, flag }

function coworkShieldConfigKey(orgId) {
    return `${CONFIG_KEY_PREFIX}${orgId}`;
}

/**
 * Normalise a stored blob (or nothing) into the flag shape.
 * `configured` lets a future settings screen tell "never set" from
 * "explicitly off" (same contract as org-ai-context).
 */
function normalizeCoworkShieldFlag(stored) {
    const enabled = stored === true
        || (!!stored && typeof stored === 'object' && stored.enabled === true);
    return {
        enabled,
        configured: stored !== null && stored !== undefined,
    };
}

/**
 * Resolve the flag for an organisation. `orgId` may be null (personal
 * account) — no org, no shield claim.
 *
 * Never throws; memoised for CACHE_TTL_MS (the scheduler ticks every run
 * through this).
 *
 * @returns {Promise<{enabled: boolean, configured: boolean}>}
 */
async function resolveCoworkShieldFlag(orgId) {
    if (!orgId) return DEFAULT_FLAG;
    const hit = _cache.get(orgId);
    if (hit && (Date.now() - hit.at) < CACHE_TTL_MS) return hit.flag;

    let stored = null;
    try {
        stored = await configStore.getConfig(coworkShieldConfigKey(orgId));
    } catch (err) {
        log.warn(`[CoworkShieldFlag] Failed to read flag for org ${orgId}: ${err.message}`);
    }
    const flag = normalizeCoworkShieldFlag(stored);
    _cache.set(orgId, { at: Date.now(), flag });
    return flag;
}

/** Convenience for the run path: just the boolean. */
async function isCoworkShieldEnabled(orgId) {
    return (await resolveCoworkShieldFlag(orgId)).enabled;
}

/** Drop the memoised value for an org (for the future settings route's save). */
function invalidateCoworkShieldFlag(orgId) {
    _cache.delete(orgId);
}

module.exports = {
    resolveCoworkShieldFlag,
    isCoworkShieldEnabled,
    invalidateCoworkShieldFlag,
    normalizeCoworkShieldFlag,
    coworkShieldConfigKey,
    CONFIG_KEY_PREFIX,
};
