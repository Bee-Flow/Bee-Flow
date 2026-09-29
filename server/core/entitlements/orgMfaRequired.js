/**
 * Org-scoped MFA duty (A3) — the READ side only.
 *
 * The platform already has ONE MFA duty: `require_mfa_for_password_accounts`,
 * a super-admin config (auth/login/signupPolicyRoutes.js) whose reader treats
 * a missing value as TRUE (`?? true` in auth/login/currentUserRoutes.js).
 * This module adds the per-organisation duty next to it, following the
 * per-org flag idiom of core/llm/contextPolicy.js:
 *
 *   - stored under `org_mfa_required_<orgId>` in configStore;
 *   - a MISSING or malformed value normalises to FALSE — deliberately NOT
 *     `?? true` like the platform flag. The org flag may only ADD the duty
 *     (callers OR it with the platform flag); reading absent as true would
 *     force MFA onto every org the moment this ships, which is exactly the
 *     "nobody loses or silently gains anything" rule this release is under;
 *   - never throws: a config-store failure falls back to false, i.e. only the
 *     platform flag counts — the pre-change behaviour, and the rollback-safe
 *     floor. The platform flag's own missing⇒true default remains the
 *     security backstop, so this fallback never disables MFA for anyone.
 *
 * Per the release split (two-release rule for security semantics): this
 * release ships ONLY the read side — currentUserRoutes ORs this flag into
 * `mfaSetupRequired`. There is deliberately no write route/UI yet; existing
 * orgs are stamped explicitly off by migrations/org-mfa-required-2026-09.js,
 * so after a rollback there is no admin-visible setting that silently stops
 * being enforced.
 *
 * The SSO exemption is NOT decided here: an SSO login's IdP owns MFA, and
 * currentUserRoutes applies that exemption after combining the flags — an org
 * duty must never force TOTP onto accounts whose identity provider already
 * enforces its own second factor.
 */

const configStore = require('../../stores/configStore');
const log = require('../../telemetry/log');

const CONFIG_KEY_PREFIX = 'org_mfa_required_';
const CACHE_TTL_MS = 30_000;

const _cache = new Map(); // orgId → { at, required }

function orgMfaConfigKey(orgId) {
    return `${CONFIG_KEY_PREFIX}${orgId}`;
}

/**
 * Normalise a stored blob (or nothing) into a boolean duty.
 * Missing, malformed, or anything but an explicit true reads as FALSE.
 */
function normalizeOrgMfaRequired(stored) {
    if (stored === true) return true;
    if (stored && typeof stored === 'object' && stored.required === true) return true;
    return false;
}

/**
 * Resolve the org-level MFA duty. `orgId` may be null/'' (consumer account,
 * org-less signup) — those have no org duty by definition.
 *
 * Never throws; memoised for CACHE_TTL_MS because this sits on the /auth/user
 * hot path.
 *
 * @returns {Promise<boolean>}
 */
async function resolveOrgMfaRequired(orgId) {
    if (!orgId) return false;
    const hit = _cache.get(orgId);
    if (hit && (Date.now() - hit.at) < CACHE_TTL_MS) return hit.required;

    let stored = null;
    try {
        stored = await configStore.getConfig(orgMfaConfigKey(orgId));
    } catch (err) {
        log.warn(`[OrgMfaRequired] Failed to read flag for org ${orgId}: ${err.message}`);
    }
    const required = normalizeOrgMfaRequired(stored);
    _cache.set(orgId, { at: Date.now(), required });
    return required;
}

/** Drop the memoised value for an org (for the future settings route's save). */
function invalidateOrgMfaRequired(orgId) {
    _cache.delete(orgId);
}

module.exports = {
    resolveOrgMfaRequired,
    invalidateOrgMfaRequired,
    normalizeOrgMfaRequired,
    orgMfaConfigKey,
    CONFIG_KEY_PREFIX,
};
