// @typecheck
/**
 * Which encryption tier a BRAND-NEW organisation starts on.
 *
 * `encryptionPolicy.defaultTier()` has read BEEFLOW_DEFAULT_ENCRYPTION_TIER
 * since the policy module landed, and it was tested — but nothing ever called
 * it on the create path. `createOrganization` never wrote `encryption_tier`,
 * so every new org fell to the column DEFAULT of 'none' no matter what the
 * operator had configured. An operator who set the variable and read the
 * policy module would reasonably believe new orgs were being encrypted. A
 * silently inert security control is worse than an absent one, which is the
 * rule encryptionPolicy.js already states about IMPLEMENTED_SURFACES; this
 * module is the same rule applied to the tier itself.
 *
 * ── Why this narrows, and never widens ──────────────────────────────────────
 *
 * Storing a tier the server cannot honour is the specific failure the admin
 * route refuses with a 409: resolveCrypto then falls back to plaintext with
 * only a console.error, and the org believes it is encrypted. So this runs the
 * SAME gate the admin route runs (getEncryptionAvailability), and anything
 * short of "selectable" lands the org on 'none'. Unknown narrows. A thrown
 * error narrows. A missing availability answer narrows.
 *
 * ── Why it is safe to do this at create time, awaited ───────────────────────
 *
 * It must run AFTER the plan/trial assignment — entitlement is resolved from
 * the org's plan, so asking earlier answers "not entitled" for every org. And
 * it must be AWAITED rather than deferred: the caller attaches the founding
 * user immediately afterwards, and any write that beats the UPDATE is written
 * in plaintext.
 *
 * The counterpart hazard on the admin route — switching an existing org into
 * `zk` while sessions are open, which keeps writing plaintext until the cookie
 * expires — does not exist here. A brand-new org has no users and therefore no
 * sessions; the founding user's first login derives their DEK through the
 * normal path.
 */

const { defaultTier, invalidatePolicyCache } = require('./encryptionPolicy');
const log = require('../telemetry/log');

/**
 * Raise a freshly created organisation to the operator's configured default
 * tier, if and only if that tier is actually available to it.
 *
 * Never throws: a failure here must not fail organisation creation. The org
 * simply stays on 'none', which is the state it was already in.
 *
 * @param {string} orgId
 * @param {object} [deps] injection seam for tests
 * @returns {Promise<{tier: string, applied: boolean, reason: string}>}
 */
async function applyDefaultEncryptionTier(orgId, deps = {}) {
    const NONE = (reason) => ({ tier: 'none', applied: false, reason });

    if (!orgId || typeof orgId !== 'string') return NONE('no_org_id');

    let wanted;
    try {
        wanted = (deps.defaultTier || defaultTier)();
    } catch (_) {
        return NONE('default_tier_threw');
    }
    // 'none' is not a downgrade to perform — the column already says 'none'.
    // Writing it anyway would produce an audit entry for a change that did not
    // happen, on every single org creation.
    if (!wanted || wanted === 'none') return NONE('default_is_none');

    let availability;
    try {
        const getAvailability = deps.getEncryptionAvailability
            || require('./encryptionAvailability').getEncryptionAvailability;
        availability = await getAvailability(orgId);
    } catch (e) {
        log.error(`[Encryption] Availability check failed for new org '${orgId}' — starting on 'none' rather than a tier this server may not honour: ${e.message}`);
        return NONE('availability_threw');
    }

    const opt = availability && Array.isArray(availability.tiers)
        ? availability.tiers.find(t => t && t.tier === wanted)
        : null;
    if (!opt || !opt.selectable) {
        // Two distinct causes, kept apart for the operator the same way the
        // admin route keeps them apart for the UI: a billing answer and a
        // config answer need different fixes.
        const why = opt ? (opt.blockedBy || 'unavailable') : 'unknown_tier';
        log.warn(`[Encryption] BEEFLOW_DEFAULT_ENCRYPTION_TIER='${wanted}' not applied to new org '${orgId}' (${why}${opt && opt.reason ? `: ${opt.reason}` : ''}) — org starts on 'none'.`);
        return NONE(`not_selectable_${why}`);
    }

    try {
        const store = deps.userStore || require('./userStore');
        const ok = await store.updateOrganization(orgId, { encryptionTier: wanted });
        // updateOrganization signals a DB failure by returning false rather
        // than throwing, so a bare await would swallow it.
        if (ok === false) {
            log.error(`[Encryption] Could not store tier '${wanted}' on new org '${orgId}' — it remains on 'none'.`);
            return NONE('update_returned_false');
        }
    } catch (e) {
        log.error(`[Encryption] Could not store tier '${wanted}' on new org '${orgId}' — it remains on 'none': ${e.message}`);
        return NONE('update_threw');
    }

    try { invalidatePolicyCache(orgId); } catch (_) { /* non-fatal */ }

    // Same persistent trail the admin route writes, so "who put this org on
    // this tier" has one answer whether a human or the default did it.
    try {
        const store = deps.userStore || require('./userStore');
        await store.logAccessAudit(
            'org.encryption.update', 'organization', orgId, 'system',
            { tier: 'none', scope: null },
            { tier: wanted, scope: null, source: 'BEEFLOW_DEFAULT_ENCRYPTION_TIER' },
            orgId,
        );
    } catch (_) { /* logAccessAudit already swallows; belt and braces */ }

    log.info(`[Encryption] New org '${orgId}' starts on tier '${wanted}' (BEEFLOW_DEFAULT_ENCRYPTION_TIER).`);
    return { tier: wanted, applied: true, reason: 'applied' };
}

module.exports = { applyDefaultEncryptionTier };
