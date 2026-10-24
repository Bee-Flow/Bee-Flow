/**
 * Beta Features — Central registry + gating helpers
 *
 * Manages which beta features exist and which organizations have access.
 * Beta features are stored per-organization in the `beta_features` column
 * on the `organizations` table (JSON array of feature IDs).
 *
 * Usage:
 *   const { requireBetaFeature, userHasBetaFeature } = require('./betaFeatures');
 *
 *   // In a route:
 *   router.get('/cool-thing', requireBetaFeature('advanced_analytics'), (req, res) => { ... });
 *
 *   // In business logic:
 *   if (await userHasBetaFeature(userId, 'meeting_notes', req.session)) { ... }
 */
// @typecheck
const { exec, getOne, run } = require('../../db');
const { tagGate } = require('../../auth/gateMeta');
const { buildKey } = require('../../utils/buildInfo');
const log = require('../../telemetry/log');
const { HttpError } = require('../../shared/httpErrors');
const {
    BETA_FEATURES, BetaLifecycle, getFeatureLifecycle, setRemoteBetaFeatures,
    listRemoteBetaFeatures, listBetaFeatures, listCompoundGatedFeatures,
} = require('./betaCatalog');
const { bestEffort, fallback } = require('../../utils/bestEffort');


// ──────────────────────────────────────────────
// Tier short-circuit — beta features are an enterprise+ benefit.
//
// On a community-tier install (no licence key, or one resolving to the
// community floor) every beta opt-in is silently denied so the matrix
// in docs/docs/licensing/tiers.md actually means something. Super-admins
// bypass via the existing `session.isAdmin` shortcut in
// getUserBetaFeatures.
//
// `_licenseModule()` is lazy-required to break the betaFeatures ↔ license
// import cycle: license/middleware.js is loaded during server boot and
// indirectly pulls in /auth/my-permissions, which requires this file.
// Resolving licence at module-load time would deadlock.
// ──────────────────────────────────────────────
const BETA_TIER_FLOOR = 'enterprise';
let _license = null;
function _licenseModule() {
    if (!_license) _license = require('../../license/index');
    return _license;
}

// True only when a server-wide licence governs every org (self-hosted). On
// cloud each org pays its own subscription, so this is false and the
// subscription leads. Fails safe to `false` (cloud) if the licence module
// can't be resolved — matching getEffectiveOrgBetaAllowList's default.
function serverLicenseGovernsOrgsSafe() {
    try {
        const lic = _licenseModule();
        return !!(lic.serverLicenseGovernsOrgs && lic.serverLicenseGovernsOrgs());
    } catch (_) {
        return false;
    }
}

/**
 * True iff the resolved tier for the given scope is at or above the beta
 * floor. Caller passes the scope it already has — `tierHint` short-circuits
 * the resolve when the licence middleware already cached a result for the
 * current request.
 *
 * Throws `FeatureServiceUnavailableError` on resolve failure (fail closed)
 * so request-path callers can surface a 503 retry rather than silently
 * granting access. Background callers (cron) wrap this with a try/catch
 * and fail-quiet — matching the existing fail-quiet stance in
 * `orgHasBetaFeature`.
 */
async function _scopeAllowsBeta({ userId = null, organizationId = null, tierHint = null } = {}) {
    // On a cloud deployment there is no server-wide licence to reference and
    // no enterprise tier floor: beta access is decided entirely by the org's
    // SUBSCRIPTION (getEffectiveOrgBetaAllowList) + the org-admin enabled
    // subset. Only self-hosted installs (where a server-wide licence governs
    // every org) apply the tier floor below.
    try {
        const lic = _licenseModule();
        if (!lic.serverLicenseGovernsOrgs || !lic.serverLicenseGovernsOrgs()) {
            return true;
        }
    } catch (err) { bestEffort('core/entitlements/betaFeatures:_scopeAllowsBeta', err); /* fall through to the tier check */ }
    if (tierHint) {
        return _licenseModule().tiers.tierAtLeast(tierHint, BETA_TIER_FLOOR);
    }
    try {
        const lic = _licenseModule();
        const tier = await lic.resolveTier({ organizationId, userId });
        return lic.tiers.tierAtLeast(tier, BETA_TIER_FLOOR);
    } catch (e) {
        throw new FeatureServiceUnavailableError(e);
    }
}


// -──────────────────────────────────────────────
// Lazy migration — ensure the column exists (deferred until first use)
// ──────────────────────────────────────────────
let migrated = false;
async function ensureColumn() {
    if (migrated) return;
    try {
        await exec(`ALTER TABLE organizations ADD COLUMN IF NOT EXISTS beta_features TEXT DEFAULT '[]'`);
        log.info('[BetaFeatures] Added beta_features column to organizations table');
    } catch (err) { log.debug('Column already exists or table doesn\'t exist yet — expected during cold start', err); }
    migrated = true;
}

// ──────────────────────────────────────────────
// Data helpers
// ──────────────────────────────────────────────

/**
 * Get the beta feature IDs enabled for an organization.
 * @param {string} orgId
 * @returns {Promise<string[]>}
 */
async function getOrgBetaFeatures(orgId) {
    try {
        await ensureColumn();
        const row = await getOne('SELECT beta_features FROM organizations WHERE id = $1', [orgId]);
        if (!row || !row.beta_features) return [];
        return JSON.parse(row.beta_features);
    } catch (_) {
        return [];
    }
}

/**
 * Set the beta feature IDs for an organization.
 * @param {string} orgId
 * @param {string[]} features — array of feature IDs from the registry
 * @returns {Promise<boolean>}
 */
async function setOrgBetaFeatures(orgId, features) {
    try {
        await ensureColumn();
        // Include active remote-module beta ids so an org admin can grant them.
        const validIds = new Set(listBetaFeatures().map(f => f.id));
        const filtered = features.filter(id => validIds.has(id));
        await run('UPDATE organizations SET beta_features = $1 WHERE id = $2', [JSON.stringify(filtered), orgId]);
        return true;
    } catch (err) {
        log.error('[BetaFeatures] setOrgBetaFeatures error:', err);
        return false;
    }
}

/**
 * Resolve the effective beta-feature ALLOW-LIST for an organisation.
 *
 * This is the "what is this org entitled to" question, and the answer depends
 * on the deployment model:
 *
 *   - self-hosted (server licence governs): the admin-managed
 *     per-org grant in `organizations.beta_features` is authoritative.
 *   - cloud: the org's SUBSCRIPTION leads. The plan's `allowed_beta_features`
 *     is the source of truth — `null` grants every beta in the registry, an
 *     array restricts to those ids. This deliberately leads over whatever the
 *     admin Security→Beta panel wrote, so the subscription is what customers
 *     actually get. Falls back to the admin grant only when the org has no
 *     resolvable subscription/plan.
 *
 * The org-admin "enabled" subset (`org_enabled_beta_features`) is still
 * intersected on top by callers — this function answers allow-list only.
 */
async function getEffectiveOrgBetaAllowList(orgId) {
    if (!orgId) return [];
    let serverGoverns = false;
    try {
        const lic = _licenseModule();
        serverGoverns = !!(lic.serverLicenseGovernsOrgs && lic.serverLicenseGovernsOrgs());
    } catch (err) { fallback('core/entitlements/betaFeatures:getEffectiveOrgBetaAllowList', err); /* default cloud */ }

    if (serverGoverns) {
        return getOrgBetaFeatures(orgId);
    }

    try {
        const userStore = require('../../stores/userStore');
        const sub = await userStore.getOrgSubscription(orgId);
        const plan = sub?.plan_id ? await userStore.getPlan(sub.plan_id) : null;
        if (plan) {
            const allowed = plan.allowed_beta_features; // null = unrestricted
            if (allowed == null) return BETA_FEATURES.map(f => f.id);
            return Array.isArray(allowed) ? allowed.slice() : [];
        }
    } catch (e) {
        log.warn('[BetaFeatures] effective allow-list (subscription) lookup failed:', e.message);
    }
    // Cloud, no resolvable subscription/plan → base tier only: NO betas. The
    // subscription is the sole source of truth on cloud, so the org-level beta
    // toggle (organizations.beta_features) is NOT load-bearing here — an org
    // without a plan gets nothing beyond base capabilities. (Self-hosted already
    // returned the admin-managed org grant via the serverGoverns branch above.)
    return [];
}

/**
 * Resolve the full set of beta features available to a user.
 * Super admins get ALL features.
 *
 * @param {string} userId
 * @param {object|null} session — express session (for isAdmin flag)
 * @returns {Promise<string[]>} array of feature IDs
 */
/**
 * Sentinel error thrown when the feature lookup itself failed (DB down,
 * Redis unreachable, etc.) — distinguishes "no features" from "couldn't
 * tell". Callers (middleware) translate this to a 503 so customers see a
 * retryable error instead of silently losing access to features they pay
 * for.
 */
class FeatureServiceUnavailableError extends Error {
    constructor(cause) {
        super('feature_service_degraded');
        this.name = 'FeatureServiceUnavailableError';
        this.cause = cause;
    }
}

async function getUserBetaFeatures(userId, session = null, { tierHint = null } = {}) {
    if (session?.isAdmin) {
        return BETA_FEATURES.map(f => f.id);
    }

    let user;
    try {
        const userStoreUser = require('../../stores/userStore');
        user = await userStoreUser.getUser(userId);
    } catch (err) {
        log.error('[BetaFeatures] user lookup failed:', err.message);
        throw new FeatureServiceUnavailableError(err);
    }
    if (!user) return [];

    if (user.role === 'admin') return BETA_FEATURES.map(f => f.id);

    // Tier short-circuit: beta features require enterprise+. Reuses the
    // licence-middleware cache on req.session._lic:<userId>:v<ver> when caller
    // passes tierHint; otherwise resolves on demand. Throws
    // FeatureServiceUnavailableError on lookup failure so the caller
    // surfaces a 503 rather than silently granting access.
    //
    // The :v<ver> suffix and the buildKey() stamp mirror license/middleware.js —
    // the key is versioned by the install-wide server-licence counter (so a
    // server-wide activation bust applies install-wide) AND by the build version
    // (the memo lives in the cross-process session record; without the stamp a
    // rolling deploy would let old/new pods read each other's resolutions).
    // This must stay byte-identical to the writer's key or the memo never hits.
    const serverVer = _licenseModule().getServerLicenseVersion ? _licenseModule().getServerLicenseVersion() : 0;
    const cacheKey = buildKey(`_lic:${userId}:v${serverVer}`);
    const cached = session && session[cacheKey];
    const cachedTier = cached?.value?.tier && cached.expiresAt > Date.now() ? cached.value.tier : null;
    const effectiveHint = tierHint || cachedTier;
    const orgIdForResolve = user.organizationId || (Array.isArray(user.groups) ? null : null);
    // Self-hosted ONLY: below the enterprise beta floor (a Community install),
    // the only betas available are the GA features whose licence feature is part
    // of the Community tier — the n8n-style free builder (Automations + Agent
    // Automations). Everything else stays Enterprise-gated. Derived from the
    // registry + the licence tier so it self-tracks tiers.js (no hand-maintained
    // id list).
    //
    // On CLOUD this tier floor does NOT apply: the SUBSCRIPTION is the source of
    // truth, so a plan may include enterprise betas (e.g. webpages) on a
    // community-priced tier. We fall through to the org allow-list resolution
    // below (getEffectiveOrgBetaAllowList), and the entitlements ceiling's
    // compound-licence term — derived from the same plan beta list — backs it.
    // Short-circuit eval skips _scopeAllowsBeta entirely on cloud.
    if (serverLicenseGovernsOrgsSafe()
        && !(await _scopeAllowsBeta({ userId, organizationId: orgIdForResolve, tierHint: effectiveHint }))) {
        const lic = _licenseModule();
        return BETA_FEATURES
            .filter(f => getFeatureLifecycle(f) === BetaLifecycle.GA
                && f.licenseFeature
                && lic.tiers.tierHasFeature('community', f.licenseFeature))
            .map(f => f.id);
    }

    let groupIds = [];
    if (Array.isArray(user.groups)) {
        groupIds = user.groups;
    } else {
        try { groupIds = JSON.parse(user.groups || '[]'); } catch (_) { fallback('core/entitlements/betaFeatures:getUserBetaFeatures', _); /* user.groups is not valid JSON, treat as no group membership */ }
    }

    let allGroups;
    try {
        const userStoreGroups = require('../../stores/userStore');
        allGroups = await userStoreGroups.getAllGroups();
    } catch (err) {
        log.error('[BetaFeatures] groups lookup failed:', err.message);
        throw new FeatureServiceUnavailableError(err);
    }

    const orgIds = new Set();
    if (user.organizationId) orgIds.add(user.organizationId);
    for (const gid of groupIds) {
        const group = allGroups.find(g => g.id === gid);
        if (group?.organizationId) orgIds.add(group.organizationId);
    }

    // Resolve the org's effective beta features.
    //
    //   - cloud: the SUBSCRIPTION leads. A feature in the plan's allow-list
    //     (getEffectiveOrgBetaAllowList) is enabled for the whole org, full
    //     stop — there is no second org-admin opt-in. The org-admin "active"
    //     subset is non-load-bearing on cloud (the org-admin beta toggles are
    //     read-only there); this keeps "a feature enabled in the subscription
    //     just works" true end-to-end.
    //   - self-hosted: unchanged. The super-admin allow-list AND the org-admin
    //     "active" subset must BOTH include a feature for it to be available.
    //     GA-lifecycle features auto-enable when allowed (org admins can flip
    //     them off explicitly, but don't need to opt in).
    const serverGoverns = serverLicenseGovernsOrgsSafe();
    const gaSet = new Set(
        BETA_FEATURES.filter(f => f.lifecycle === BetaLifecycle.GA).map(f => f.id)
    );
    const featureSet = new Set();
    try {
        const userStoreBeta = require('../../stores/userStore');
        for (const orgId of orgIds) {
            const allowed = await getEffectiveOrgBetaAllowList(orgId);
            const allowedSet = new Set(allowed);
            if (!serverGoverns) {
                // Cloud: subscription is leading — allow-list membership ⇒ on.
                for (const fid of allowedSet) featureSet.add(fid);
                continue;
            }
            const active = await userStoreBeta.getOrgEnabledBetaFeatures(orgId);
            const activeSet = new Set(active);
            for (const fid of allowedSet) {
                if (activeSet.has(fid)) { featureSet.add(fid); continue; }
                // GA: auto-active unless org-admin has explicitly turned it
                // off. The org-admin "off" representation is presence in
                // `active` for everything else — for GA we need an explicit
                // opt-out marker. We treat absence-from-active as "default
                // on" for GA features.
                if (gaSet.has(fid)) featureSet.add(fid);
            }
        }
    } catch (err) {
        log.error('[BetaFeatures] org allow-list lookup failed:', err.message);
        throw new FeatureServiceUnavailableError(err);
    }

    // Per-group beta grants (grant-only, additive). A beta granted to one of the
    // user's groups becomes available even if it isn't enabled org-wide — as long
    // as it is within that org's allow-list/ceiling. Only reached for enterprise+
    // (the community short-circuit above already returned), so the compound
    // license term is satisfied by the tier. Scoped per the group's own org.
    try {
        const betaIdSet = new Set(BETA_FEATURES.map(f => f.id));
        const allowCache = new Map();
        for (const gid of groupIds) {
            const group = allGroups.find(g => g.id === gid);
            if (!group || !group.organizationId || !orgIds.has(group.organizationId)) continue;
            const granted = Array.isArray(group.granted_capabilities) ? group.granted_capabilities : [];
            if (granted.length === 0) continue;
            let allowed = allowCache.get(group.organizationId);
            if (!allowed) {
                allowed = new Set(await getEffectiveOrgBetaAllowList(group.organizationId));
                allowCache.set(group.organizationId, allowed);
            }
            for (const capId of granted) {
                if (betaIdSet.has(capId) && allowed.has(capId)) featureSet.add(capId);
            }
        }
    } catch (err) {
        log.warn('[BetaFeatures] per-group beta grant resolution failed:', err.message);
    }

    return [...featureSet];
}

/**
 * Given a feature ID, return the set of IDs that count as "the same feature"
 * for access-check purposes — the canonical target plus any deprecated
 * aliases pointing to it (and the reverse direction).
 */
function resolveFeatureAliases(featureId) {
    const ids = new Set([featureId]);
    for (const entry of BETA_FEATURES) {
        if (entry.id === featureId && entry.aliasOf) ids.add(entry.aliasOf);
        if (entry.aliasOf === featureId) ids.add(entry.id);
    }
    return ids;
}

/**
 * Check if a specific user has access to a beta feature.
 * Aliased feature IDs (a deprecated id pointing at its canonical replacement
 * via `aliasOf`) are treated as equivalent.
 */
async function userHasBetaFeature(userId, featureId, session = null) {
    const ent = require('./entitlements');
    // Unified path: for any capability with a registry row, the single resolver
    // (resolveEntitlements) is the source of truth — identical to the route-mount
    // requireCapability gate, so the inline check and the API gate can never
    // drift (this is what made the webpages page render while its API 403'd).
    if (ent.registry.getCapability(featureId)) {
        // Reconstruct request context from the session so the resolver does the
        // full multi-org (primary + group orgs) resolution and reuses the
        // per-session cache. resolveBestTierForRequest / resolveUserOrgIds read
        // only req.session, so a synthetic { session } req is faithful.
        const req = session ? { session } : null;
        let orgId = session?.user?.organizationId || session?.user?.orgId || null;
        if (!orgId && userId && !req) {
            // Background caller (null session): resolve the user's primary org so
            // the subscription/org grant layer is populated (mirrors the legacy
            // org sweep). Group-org sweep is covered by the request path above.
            try { const u = await require('../../stores/userStore').getUser(userId); orgId = u?.organizationId || null; } catch (err) { fallback('core/entitlements/betaFeatures:userHasBetaFeature', err); /* fail closed below */ }
        }
        return ent.hasCapability(featureId, { userId, orgId, session, req });
    }
    // Orphan id without a registry row (e.g. 'templates'): preserve the raw plan/
    // org beta allow-list membership the resolver can't express. getUserBetaFeatures
    // is intentionally left unchanged for exactly this path.
    const aliases = resolveFeatureAliases(featureId);
    try {
        const userFeatures = await getUserBetaFeatures(userId, session);
        return userFeatures.some(id => aliases.has(id));
    } catch (_) {
        return false;
    }
}

/**
 * Check whether an organization has a beta feature available. Used by
 * background runners (automations, schedulers) where there's no user session
 * to pass through `userHasBetaFeature`. Mirrors `getUserBetaFeatures`:
 *   - cloud: the subscription leads — allow-list membership ⇒ available.
 *   - self-hosted: the super-admin allow-list AND the org-admin active subset
 *     must both contain the feature (GA features auto-enable when allowed).
 */
async function orgHasBetaFeature(orgId, featureId, { tierHint = null } = {}) {
    if (!orgId) return false;
    const ent = require('./entitlements');
    // Unified path: delegate org-wide capability checks (background runners,
    // schedulers) to the single resolver so they agree with requireCapability.
    if (ent.registry.getCapability(featureId)) {
        return ent.hasCapability(featureId, { orgId, tierHint });
    }
    // Orphan id (no registry row): preserve the raw allow-list membership the
    // resolver can't express, with the original cloud/self-hosted branching.
    try {
        if (!(await _scopeAllowsBeta({ organizationId: orgId, tierHint }))) return false;
        const aliases = resolveFeatureAliases(featureId);
        const allowed = new Set(await getEffectiveOrgBetaAllowList(orgId));
        if (!serverLicenseGovernsOrgsSafe()) {
            for (const id of aliases) { if (allowed.has(id)) return true; }
            return false;
        }
        const gaSet = new Set(BETA_FEATURES.filter(f => f.lifecycle === BetaLifecycle.GA).map(f => f.id));
        const userStore = require('../../stores/userStore');
        let active = [];
        try { active = await userStore.getOrgEnabledBetaFeatures(orgId); } catch (_) { active = []; }
        const activeSet = new Set(active);
        for (const id of aliases) {
            if (!allowed.has(id)) continue;
            if (activeSet.has(id)) return true;
            if (gaSet.has(id)) return true;
        }
        return false;
    } catch (err) {
        log.error('[BetaFeatures] orgHasBetaFeature error:', err);
        return false;
    }
}

/**
 * Express middleware factory — gates a route behind a beta feature flag.
 *
 * Three response paths:
 *   - feature allowed       → next()
 *   - feature not allowed   → 403 (definitive answer)
 *   - lookup itself failed  → 503 with Retry-After=10 (caller retries)
 *
 * The 503 path is critical: previously, any DB error returned an empty
 * feature list, silently kicking customers out of features they pay for.
 * Now those failures surface as transient errors customers can retry.
 */
function requireBetaFeature(featureId) {
    const ent = require('./entitlements');
    // Unified path: for any registered capability, delegate to the single
    // capability gate so beta route mounts emit the same vocabulary
    // (feature_locked / feature_disabled / entitlement_unavailable) as every
    // other gate and resolve through the one source of truth. requireCapability
    // throws on an unknown id, so this branch is taken only for real features.
    if (ent.registry.getCapability(featureId)) {
        return ent.requireCapability(featureId);
    }
    // Legacy fallback — orphan ids without a registry row (e.g. 'templates',
    // pending a product tier decision). Preserves the original beta-membership
    // semantics and response shapes via the unchanged getUserBetaFeatures.
    // (The registry path above delegates to requireCapability, which is already
    // tagged; only this arm needs its own tag.)
    return tagGate(async (req, res, next) => {
        if (!req.session?.user) {
            return res.status(401).json({ error: 'Not authenticated' });
        }
        const userId = req.session.user?.id;
        try {
            const feats = await getUserBetaFeatures(userId, req.session);
            const aliases = resolveFeatureAliases(featureId);
            if (feats.some(id => aliases.has(id))) {
                return next();
            }
            const serverVerForCache = _licenseModule().getServerLicenseVersion ? _licenseModule().getServerLicenseVersion() : 0;
            const cached = req.session?.[buildKey(`_lic:${userId}:v${serverVerForCache}`)];
            const cachedTier = cached?.expiresAt > Date.now() ? cached.value?.tier : null;
            const allowed = await _scopeAllowsBeta({
                organizationId: req.session.user.organizationId,
                userId,
                tierHint: cachedTier,
            }).catch(() => false);
            if (!allowed) {
                return res.status(403).json({
                    error: 'feature_locked',
                    feature: featureId,
                    reason: 'beta_requires_enterprise',
                    required: BETA_TIER_FLOOR,
                    upgrade_url: process.env.LICENSE_UPGRADE_URL || 'https://beeflow.nl/pricing',
                });
            }
            return res.status(403).json({ error: `Beta feature '${featureId}' is not enabled for your organization` });
        } catch (err) {
            if (err instanceof FeatureServiceUnavailableError) {
                res.set('Retry-After', '10');
                return next(new HttpError(503, 'feature_service_degraded', 'feature_service_degraded', {
                    message: 'Feature service is temporarily unavailable. Please retry shortly.',
                }));
            }
            log.error('[BetaFeatures] middleware error:', err);
            return next(new HttpError(500, 'feature_check_failed', 'feature_check_failed'));
        }
    }, { axis: 'capability', id: featureId, kind: 'beta', legacy: true });
}

module.exports = {
    BETA_FEATURES,
    BetaLifecycle,
    listBetaFeatures,
    setRemoteBetaFeatures,
    listRemoteBetaFeatures,
    listCompoundGatedFeatures,
    getFeatureLifecycle,
    getOrgBetaFeatures,
    setOrgBetaFeatures,
    getEffectiveOrgBetaAllowList,
    getUserBetaFeatures,
    userHasBetaFeature,
    orgHasBetaFeature,
    requireBetaFeature,
    FeatureServiceUnavailableError,
};
