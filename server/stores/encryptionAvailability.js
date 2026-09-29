// @typecheck
/**
 * Which encryption tiers may this organisation actually select?
 *
 * Two independent questions, deliberately kept apart because they fail
 * differently and the UI must say different things about them:
 *
 *   ENTITLEMENT  — "does your plan/licence include encryption?"
 *                  A commercial answer. House style for org settings surfaces
 *                  is to clamp and upsell, not to 403 the route: the option is
 *                  rendered disabled with a badge and an upgrade link. See
 *                  orgPrivacyShield's _applyTierClamps and the rationale in
 *                  guardrails/orgShield/tabs/ProcessingTab.jsx, which spells
 *                  out why hiding the locked option is the worst outcome.
 *
 *   READINESS    — "can this deployment actually deliver that tier?"
 *                  A configuration answer. Selecting a tier the server cannot
 *                  honour is refused outright (409), because the failure mode
 *                  is silent: resolveCrypto falls back to PLAINTEXT_CONTEXT and
 *                  keeps writing plaintext with only a console.error, so the
 *                  org would believe its data is encrypted when it is not.
 *
 * A tier is selectable only when it is BOTH entitled and ready.
 */

const { TIERS, resolvePolicy } = require('./encryptionPolicy');
// Reads a cached verdict only; this module never loads the OPAQUE WASM.
const { getServerSetupStatus } = require('../auth/opaqueSetup');
const log = require('../telemetry/log');

const FEATURE = 'encryption';

/**
 * Is this org entitled to content encryption?
 *
 * `license.hasFeature` unions the licence TIER with the plan's additive
 * `allowed_features` grant, which is what makes one call correct on both
 * deployment modes: cloud resolves the tier from the org's subscription, while
 * self-hosted resolves it from the server licence and never consults
 * subscriptions at all.
 *
 * Deliberately NOT the `requireFeature` middleware: that resolves across the
 * CALLER's orgs, which is wrong for a route scoped to an :id param, and a
 * route-level 403 cannot express *which* tiers are allowed.
 *
 * @param {string|null} orgId
 * @returns {Promise<boolean>}
 */
async function isOrgEntitled(orgId) {
    if (!orgId) return false;
    try {
        const license = require('../license/index');
        return await license.hasFeature({ organizationId: orgId }, FEATURE);
    } catch (err) {
        // Fail closed: an unresolvable licence must not silently hand out a
        // paid feature.
        log.warn(`[EncryptionAvailability] entitlement check failed for org ${orgId}: ${err.message}`);
        return false;
    }
}

/**
 * Per-tier deployment readiness. Pure environment inspection — no I/O, no org
 * lookup — so it is cheap and unit-testable.
 *
 * `managed` needs MASTER_ENCRYPTION_KEY because the whole escrow chain hangs
 * off it (stores/orgVault.js throws without it).
 *
 * `zk` needs no extra environment. It derives the per-user DEK at login through
 * the legacy Argon2 path in getOrCreateUserDEKCompat; OPAQUE is a separate,
 * stronger login path used only when kdfMode === 'opaque_v1'. An unset
 * OPAQUE_SERVER_SETUP is therefore a WARNING, not a blocker — it means the
 * server mints an ephemeral per-process setup, so any OPAQUE enrolment stops
 * working after a restart.
 *
 * A SET but unreadable OPAQUE_SERVER_SETUP is a warning for the same reason,
 * with its own wording: the OPAQUE routes answer 503 and the SPA falls back to
 * the legacy PIN/password path (pages/EncryptionSetup.jsx), so zk still works.
 * Making it a blocker would also do harm: applyDefaultEncryptionTier
 * (initialTier.js) starts a new org on 'none' when zk is not selectable, i.e.
 * a broken OPAQUE value would quietly put new orgs on plaintext. The verdict
 * comes from the boot-time check in auth/opaqueSetup.js (cached, no WASM
 * loaded here); before that check has run, presence is all we know.
 *
 * @returns {Record<string, {ready: boolean, missing: string[], warnings: string[], reason: string|null, warningReason?: string|null}>}
 */
function tierReadiness() {
    const hasMasterKey = !!process.env.MASTER_ENCRYPTION_KEY;
    const hasOpaqueSetup = !!process.env.OPAQUE_SERVER_SETUP;
    const opaqueUnreadable = hasOpaqueSetup && getServerSetupStatus()?.valid === false;

    const managedMissing = hasMasterKey ? [] : ['MASTER_ENCRYPTION_KEY'];
    const zkWarnings = hasOpaqueSetup && !opaqueUnreadable ? [] : ['OPAQUE_SERVER_SETUP'];
    let zkWarningReason = null;
    if (opaqueUnreadable) {
        zkWarningReason = 'OPAQUE_SERVER_SETUP is set but cannot be read by this server, so OPAQUE enrolment and OPAQUE logins are unavailable until it is replaced. Password-based zero-knowledge encryption is unaffected.';
    } else if (!hasOpaqueSetup) {
        zkWarningReason = 'OPAQUE is not configured on this server, so any OPAQUE-based enrolment will stop working after a restart. Password-based zero-knowledge encryption is unaffected.';
    }

    return {
        none: { ready: true, missing: [], warnings: [], reason: null },
        managed: {
            ready: managedMissing.length === 0,
            missing: managedMissing,
            warnings: [],
            reason: managedMissing.length
                ? 'This server has no encryption master key configured, so keys cannot be created. Ask your administrator to set MASTER_ENCRYPTION_KEY and restart.'
                : null,
        },
        zk: {
            ready: true,
            missing: [],
            warnings: zkWarnings,
            reason: null,
            // Surfaced as an advisory on the card, not a blocker.
            warningReason: zkWarningReason,
        },
    };
}

const NOT_ENTITLED_REASON =
    'Encryption is not included in your current plan. Contact your administrator or upgrade to enable it.';

/**
 * Everything the admin API and the UI need to render and enforce the picker.
 *
 * @param {string|null} orgId
 * @returns {Promise<{
 *   entitled: boolean,
 *   allowedTiers: string[],
 *   readiness: Record<string, object>,
 *   tiers: Array<{tier: string, selectable: boolean, reason: string|null, missing: string[], warnings: string[],
 *                 warningReason: string|null, blockedBy: string|null}>
 * }>} `blockedBy` is 'entitlement', 'readiness' or null
 */
async function getEncryptionAvailability(orgId) {
    const entitled = await isOrgEntitled(orgId);
    const readiness = tierReadiness();

    const tiers = TIERS.map((tier) => {
        const r = readiness[tier] || /** @type {{ready: boolean, missing: string[], warnings: string[], reason?: string|null, warningReason?: string|null}} */ ({ ready: false, missing: [], warnings: [] });
        // 'none' is always selectable — an org must be able to turn encryption
        // OFF even after its entitlement lapses, or a downgrade would strand it
        // on a tier it can no longer manage.
        const needsEntitlement = tier !== 'none';
        const selectable = (!needsEntitlement || entitled) && r.ready;
        let reason = null;
        if (needsEntitlement && !entitled) reason = NOT_ENTITLED_REASON;
        else if (!r.ready) reason = r.reason;
        return {
            tier,
            selectable,
            reason,
            missing: r.missing || [],
            warnings: r.warnings || [],
            warningReason: r.warningReason || null,
            // Distinguishes the two failure classes for the UI: a billing
            // problem gets an upgrade link, a config problem gets an ops note.
            blockedBy: selectable ? null : (needsEntitlement && !entitled ? 'entitlement' : 'readiness'),
        };
    });

    return {
        entitled,
        allowedTiers: tiers.filter(t => t.selectable).map(t => t.tier),
        readiness,
        tiers,
    };
}

/**
 * Is content encryption enabled for this user's organisation?
 *
 * This is the LOGIN-TIME gate: when it returns true, finalizeLogin derives the
 * user's DEK from their password and puts it on the session, and an SSO login
 * asks the person for an encryption PIN. On the `zk` tier that session key is
 * the ONLY source of a key — there is no escrow — so this must not be laxer
 * than the admin-side entitlement check, or an org can be switched to `zk` and
 * then silently write plaintext forever.
 *
 * BOTH HALVES, because they are different questions and a key is worth
 * deriving only when both say yes:
 *
 *   entitled  — the plan or licence includes encryption at all (isOrgEntitled)
 *   enabled   — the organisation actually switched it on, i.e. its
 *               `encryption_tier` is not 'none' (resolvePolicy)
 *
 * Entitlement alone was the bug. `none` is the default tier for every org, so
 * an Enterprise org that had simply never turned encryption on still answered
 * true here — and its SSO users were shown "Set Up Data Encryption" and asked
 * for a PIN protecting nothing. Nothing came of the key either way:
 * resolveCrypto returns PLAINTEXT_CONTEXT the moment `policy.enabled` is
 * false, so the session DEK was already being ignored on every read and write.
 * The prompt was the only thing anyone ever saw of it.
 *
 * The reverse order matters too — entitlement is checked first, so a lapsed
 * org still stops deriving keys even while its tier column says `zk`.
 *
 * It previously read `allowed_features` alone, which is only the PLAN-grant
 * half of entitlement. An org entitled through its licence TIER (the normal
 * case for an enterprise licence, and the only case on self-hosted) passed the
 * admin gate and failed this one. Both now go through isOrgEntitled, so there
 * is exactly one definition of "this org may use encryption".
 *
 * @param {string} userId
 * @returns {Promise<boolean>}
 */
async function isEncryptionEnabledForUser(userId) {
    try {
        const userStore = require('./userStore');
        const user = await userStore.getUser(userId);
        if (!user) return false;
        const orgId = user.organizationId;
        if (!orgId) return false;
        if (!(await isOrgEntitled(orgId))) return false;
        // resolvePolicy never throws and fails to the disabled policy, so a
        // DB hiccup here means "no key", which is what every write path
        // already does under the same failure.
        return (await resolvePolicy(orgId)).enabled;
    } catch (_) {
        return false;
    }
}

module.exports = {
    FEATURE,
    NOT_ENTITLED_REASON,
    isOrgEntitled,
    isEncryptionEnabledForUser,
    tierReadiness,
    getEncryptionAvailability,
};
