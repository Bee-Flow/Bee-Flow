// @typecheck
/**
 * Admin Routes — feature toggles and entitlements: beta features, active
 * integrations, the unified entitlement snapshot and the Access matrix
 * (group/org grants, org availability, selected-org, consumer features).
 * Split out of auth/adminRoutes.js; mounted there in the original
 * registration order.
 */

const express = require('express');
const log = require('../../telemetry/log');
const router = express.Router();

const userStore = require('../../stores/userStore');
const { nextBetaEveryone, nextEveryoneRevoked } = require('./orgAccessCarryOver');
const { requireAuth, requireAdmin, getUserPermissions, resolveUserOrgIds, invalidateAllPermissionCaches, GROUP_GRANT_IMPLIED_PERMISSIONS } = require('../permissions');
const { requireOrgAdmin } = require('./orgAdminGuards');
const configStore = require('../../stores/configStore');
const { ALL_INTEGRATIONS } = require('./integrationCatalog');
const { validate } = require('../../core/http/validate');
const { z } = require('zod');

/** A string whose every refusal — including "you left it out" — is a sentence. */
const worded = (message) => z.string({ required_error: message, invalid_type_error: message });

/**
 * Each of these routes is a list of ids the caller wants switched on, and every
 * one of them CLAMPS what it is given to what the plan, the licence or the org
 * access menu allows — and then reports the clamped list back in the response.
 * That is a deliberate, visible narrowing, not a silent fallback, so the
 * clamping stays exactly as it is.
 *
 * What was silent is the KEY. None of these bodies refused one it did not
 * recognise, so `{"grantd": [...]}` on a capability grant, or `{"enabld":
 * [...]}` on the integration toggles, was answered 200 with the unchanged list
 * echoed back — which reads on screen as "saved" for a change that never
 * happened.
 */
const idList = (field, message) => z.array(
    worded(message),
    { required_error: message, invalid_type_error: message },
);

const FEATURES_TEXT = 'features must be an array of feature IDs';
const BetaFeaturesBody = z.object({ features: idList('features', FEATURES_TEXT) }).strict();

const INTEGRATIONS_TEXT = 'enabled must be an array of integration IDs';
const ActiveIntegrationsBody = z.object({ enabled: idList('enabled', INTEGRATIONS_TEXT) }).strict();

const ACTIVE_BETA_TEXT = 'enabled must be an array of feature IDs';
const ActiveBetaFeaturesBody = z.object({ enabled: idList('enabled', ACTIVE_BETA_TEXT) }).strict();

const ActiveFeaturesBody = z.object({
    betaEnabled: idList('betaEnabled', 'betaEnabled must be an array of feature IDs').optional(),
    integrationsEnabled: idList('integrationsEnabled', 'integrationsEnabled must be an array of integration IDs').optional(),
}).strict();

const GRANTED_TEXT = 'granted must be an array of capability ids';
const GrantedBody = z.object({ granted: idList('granted', GRANTED_TEXT) }).strict();

const AVAILABLE_TEXT = 'available must be an array of capability ids (or pass unrestricted:true)';
const OrgAvailabilityBody = z.object({
    available: idList('available', AVAILABLE_TEXT).optional(),
    unrestricted: z.boolean({ invalid_type_error: 'unrestricted must be true or false.' }).optional(),
}).strict();

// `orgId` null or '' is how the picker CLEARS the selection, so both stay.
const SelectedOrgBody = z.object({
    orgId: worded('An organization id must be text.').trim().max(200, 'That organization id is too long.').nullable().optional(),
}).strict();


// === Beta Features Management API (Admin Only) ===

const { BETA_FEATURES, getOrgBetaFeatures, setOrgBetaFeatures, getEffectiveOrgBetaAllowList } = require('../../core/entitlements/betaFeatures');

// Module layer: betas owned by an un-imported platform module must not appear
// in any raw BETA_FEATURES registry dump (these bypass the filtered
// capabilityRegistry projection) — they behave as if they don't exist on the
// instance. Fail-open to the full registry so a store hiccup never blanks the
// admin panels (grandfathered modules fail open by design).
async function visibleBetaRegistry() {
    try {
        const inactive = await require('../../modules').listInactiveCapabilityIds();
        if (!inactive || inactive.size === 0) return BETA_FEATURES;
        return BETA_FEATURES.filter(f => !inactive.has(f.id));
    } catch (_) {
        return BETA_FEATURES;
    }
}

// Whether a server-wide licence governs every org (self-hosted). On cloud
// each org's SUBSCRIPTION leads, so the per-org beta allow-list written here
// has no runtime effect — the panel becomes read-only and writes are blocked.
function betaGovernedBySubscription() {
    try {
        const lic = require('../../license');
        return !(lic.serverLicenseGovernsOrgs && lic.serverLicenseGovernsOrgs());
    } catch (_) {
        return true; // default cloud → subscription-governed
    }
}

// Get the full beta feature registry + per-org assignments.
// On cloud the assignments shown are the RESOLVED subscription allow-list
// (getEffectiveOrgBetaAllowList) — the real truth — rather than the
// admin-managed `organizations.beta_features` column, which is ignored at
// runtime there. `governed` tells the UI to render read-only on cloud.
// The catalogue of available beta flags — read-only, no tenant data.
// SystemKnowledgeBasesPanel (org-admin surface) reads it before toggling the
// caller's own org, so this stays readable; the per-org PUT is org-scoped.
router.get('/beta-features', requireAdmin, async (req, res) => {
    const governed = betaGovernedBySubscription();
    const orgs = await userStore.getAllOrganizations();
    const assignments = {};
    for (const org of orgs) {
        assignments[org.id] = governed
            ? await getEffectiveOrgBetaAllowList(org.id)
            : await getOrgBetaFeatures(org.id);
    }
    res.json({ registry: await visibleBetaRegistry(), assignments, governed });
});

// Set beta features for an organization (super-admin allow-list).
// This is the master capability list — org admins use the
// /active-beta-features routes to toggle within this set.
// requireOrgAdmin('orgId'), not requireAdmin: the previous gate never looked at
// :orgId, so any org admin could flip another organisation's beta flags. This
// stays org-scoped rather than operator-only because SystemKnowledgeBasesPanel
// (rendered inside OrgSettings) legitimately toggles the caller's OWN org.
router.put('/organizations/:orgId/beta-features', requireOrgAdmin('orgId'), validate({ body: BetaFeaturesBody }), async (req, res) => {
    const { orgId } = req.params;
    const { features } = req.body;

    // On cloud the subscription plan is authoritative; reject the write so it
    // can't silently no-op. Edit the org's plan in Subscriptions instead.
    if (betaGovernedBySubscription()) {
        return res.status(409).json({
            error: 'governed_by_subscription',
            message: "Beta access is set by the organization's subscription plan on this deployment.",
        });
    }

    if (await setOrgBetaFeatures(orgId, features)) {
        const updatedFeatures = await getOrgBetaFeatures(orgId);
        // Trim the org-admin "enabled" subset to what's still in the
        // allow-list so a feature pulled by the super admin can't linger.
        try {
            const current = await userStore.getOrgEnabledBetaFeatures(orgId);
            const trimmed = current.filter(id => updatedFeatures.includes(id));
            if (trimmed.length !== current.length) {
                await userStore.setOrgEnabledBetaFeatures(orgId, trimmed);
            }
        } catch (e) { /* non-fatal */ }
        res.json({ success: true, features: updatedFeatures });
    } else {
        res.status(500).json({ error: 'Failed to update beta features' });
    }
});

// ── Org-admin "active" subset routes ─────────────────────────────
// The super admin sets allow-lists (organizations.beta_features and
// organizations.enabledIntegrations). The org admin uses these four
// routes to flip individual items on/off within their allow-list.
// Both layers are intersected at runtime; an item must be in BOTH lists
// to be active.

const { NC_INTEGRATION_ID_SET: NC_ID_SET } = (() => {
    try { return require('../../core/integrations/ncIntegrationCatalog'); }
    catch (_) { return { NC_INTEGRATION_ID_SET: new Set() }; }
})();

function parseAllowedIntegrations(raw) {
    if (raw === null || raw === undefined) return [];
    if (Array.isArray(raw)) return raw;
    try { const v = JSON.parse(raw); return Array.isArray(v) ? v : []; }
    catch (_) { return []; }
}

router.get('/organizations/:orgId/active-integrations', requireOrgAdmin('orgId'), async (req, res) => {
    const { orgId } = req.params;
    const org = await userStore.getOrganization(orgId);
    if (!org) return res.status(404).json({ error: 'Organization not found' });
    // Allow-list is the super-admin's enabledIntegrations minus NC IDs
    // (NC is managed by its dedicated panel). null = all enabled, which
    // we materialise via the global default list at request time.
    let allowed;
    const raw = org.enabledIntegrations;
    if (raw === null || raw === undefined) {
        const globalDefaults = await configStore.getConfig('default_org_integrations');
        allowed = globalDefaults ? parseAllowedIntegrations(globalDefaults) : ALL_INTEGRATIONS.map(i => i.id);
    } else {
        allowed = parseAllowedIntegrations(raw);
    }
    allowed = allowed.filter(id => !NC_ID_SET.has(id));
    const enabled = await userStore.getOrgEnabledIntegrations(orgId);
    res.json({ allowed, enabled });
});

router.put('/organizations/:orgId/active-integrations', requireOrgAdmin('orgId'), validate({ body: ActiveIntegrationsBody }), async (req, res) => {
    const { orgId } = req.params;
    const { enabled } = req.body;
    const org = await userStore.getOrganization(orgId);
    if (!org) return res.status(404).json({ error: 'Organization not found' });
    let allowed;
    const raw = org.enabledIntegrations;
    if (raw === null || raw === undefined) {
        const globalDefaults = await configStore.getConfig('default_org_integrations');
        allowed = globalDefaults ? parseAllowedIntegrations(globalDefaults) : ALL_INTEGRATIONS.map(i => i.id);
    } else {
        allowed = parseAllowedIntegrations(raw);
    }
    const allowedSet = new Set(allowed.filter(id => !NC_ID_SET.has(id)));
    // Intersect — drop anything not in the allow-list (incl. NC IDs).
    const clean = Array.from(new Set(enabled.filter(id => allowedSet.has(id))));
    if (!(await userStore.setOrgEnabledIntegrations(orgId, clean))) {
        return res.status(500).json({ error: 'Failed to save' });
    }
    res.json({ success: true, enabled: clean });
});

router.get('/organizations/:orgId/active-beta-features', requireOrgAdmin('orgId'), async (req, res) => {
    const { orgId } = req.params;
    const governed = betaGovernedBySubscription();
    if (governed) {
        // Cloud: the subscription plan's allow-list is the source of truth
        // and every allowed beta is on. Report it read-only (governed) so
        // the org-admin panel renders the plan-granted set without toggles.
        const allowed = await getEffectiveOrgBetaAllowList(orgId);
        return res.json({ allowed, enabled: allowed, registry: await visibleBetaRegistry(), governed });
    }
    const allowed = await getOrgBetaFeatures(orgId); // returns string[] of IDs
    const enabled = await userStore.getOrgEnabledBetaFeatures(orgId);
    res.json({ allowed, enabled, registry: await visibleBetaRegistry(), governed });
});

router.put('/organizations/:orgId/active-beta-features', requireOrgAdmin('orgId'), validate({ body: ActiveBetaFeaturesBody }), async (req, res) => {
    const { orgId } = req.params;
    // On cloud, plan-granted betas are always on (the active subset is
    // non-load-bearing). The org-admin beta toggles are read-only there.
    if (betaGovernedBySubscription()) {
        return res.status(409).json({
            error: 'governed_by_subscription',
            message: "Beta features are set by your subscription plan on this deployment.",
        });
    }
    const { enabled } = req.body;
    const allowed = await getOrgBetaFeatures(orgId);
    const allowedSet = new Set(allowed);
    const clean = Array.from(new Set(enabled.filter(id => allowedSet.has(id))));
    if (!(await userStore.setOrgEnabledBetaFeatures(orgId, clean))) {
        return res.status(500).json({ error: 'Failed to save' });
    }
    res.json({ success: true, enabled: clean });
});

// ── Self-scoped active-features routes ──────────────────────────
// The org-scoped routes above require the client to know which org it is
// managing. That breaks for super admins (no direct organizationId) and
// for users whose org membership comes through groups — the SPA has no
// reliable way to pick the right org. These "/me" routes resolve the
// caller's primary org from the session instead, so the panel never has
// to guess. Auth is requireAuth + org_admin/all perm so non-admins still
// can't toggle these.

/**
 * Internal helper: resolve the user's "managed" org plus the allow-lists
 * that the active-features panel needs. Returns:
 *   { orgId, allowedBetaFeatures, enabledBetaFeatures,
 *     allowedIntegrations, enabledIntegrations, betaRegistry }
 *
 * - Super admin (resolveUserOrgIds === null) → first org from
 *   getAllOrganizations(); empty everything if no orgs exist.
 * - Org admin / member → first entry of resolveUserOrgIds.
 * - No resolvable org → orgId: null with empty allow-lists so the panel
 *   can render a "not bound" message instead of disappearing.
 */
async function resolveActiveFeaturesContext(req) {
    const userOrgIds = await resolveUserOrgIds(req);
    let orgId = null;
    if (userOrgIds === null) {
        // Super admin — pick first existing org so they get a usable view.
        const all = await userStore.getAllOrganizations().catch(() => []);
        if (Array.isArray(all) && all.length > 0) orgId = all[0].id;
    } else if (userOrgIds.size > 0) {
        orgId = Array.from(userOrgIds)[0];
    }

    if (!orgId) {
        return {
            orgId: null,
            allowedBetaFeatures: [], enabledBetaFeatures: [],
            allowedIntegrations: [], enabledIntegrations: [],
            customIntegrations: [],
            betaRegistry: await visibleBetaRegistry(),
            betaGoverned: betaGovernedBySubscription(),
        };
    }

    const org = await userStore.getOrganization(orgId);

    // Beta allow-list — the effective entitlement for this org. On cloud this
    // is driven by the org's SUBSCRIPTION (the plan's allowed_beta_features),
    // which leads over the admin Security→Beta grant; on self-hosted it is the
    // server-licence-governed admin grant. Either way a feature outside the
    // allow-list never appears in the org-admin panel.
    const grantedAllowList = await getEffectiveOrgBetaAllowList(orgId);
    const enabledBetaFeatures = await userStore.getOrgEnabledBetaFeatures(orgId);

    // Integration allow-list = super admin's enabledIntegrations (or global
    // default if null), minus NC IDs (managed separately).
    let allowedIntegrations;
    const raw = org?.enabledIntegrations;
    if (raw === null || raw === undefined) {
        const globalDefaults = await configStore.getConfig('default_org_integrations');
        allowedIntegrations = globalDefaults ? parseAllowedIntegrations(globalDefaults) : ALL_INTEGRATIONS.map(i => i.id);
    } else {
        allowedIntegrations = parseAllowedIntegrations(raw);
    }
    allowedIntegrations = allowedIntegrations.filter(id => !NC_ID_SET.has(id));
    const enabledIntegrations = await userStore.getOrgEnabledIntegrations(orgId);

    // Plan cap applies to integrations only. Beta grants are authoritative
    // over the plan ceiling (see above), so the grant list passes through
    // uncapped.
    let planCappedInt = allowedIntegrations;
    try {
        const { getOrgCaps, applyCap } = require('../../services/planEntitlements');
        const caps = await getOrgCaps(orgId);
        planCappedInt = applyCap(allowedIntegrations, caps.integrations);
    } catch (e) {
        log.warn('[ActiveFeatures] plan cap lookup failed:', e.message);
    }
    const allowedBetaFeatures = Array.from(new Set(grantedAllowList));

    // On cloud the subscription leads and every allowed beta is on, so the
    // panel renders the beta tab read-only with the full grant shown as
    // enabled. Self-hosted keeps the org-admin's saved active subset.
    const betaGoverned = betaGovernedBySubscription();

    // Custom integrations (AI Integration Builder) — surface the org's ACTIVE
    // custom integrations additively so the panel can render them alongside
    // the catalog. Fail-soft to []; hidden entirely while the dark-ship kill
    // switch is off (the same flag gates every other layer of the feature).
    let customIntegrations = [];
    try {
        const { isCustomIntegrationsEnabled } = require('../../core/customIntegrations/featureFlag');
        if (await isCustomIntegrationsEnabled()) {
            const rows = await require('../../stores/orgCustomIntegrationStore').listActiveForOrg(orgId);
            customIntegrations = rows.map(r => ({
                id: `custom:${r.id}`,
                name: r.name,
                description: r.description || '',
                category: 'Custom integrations',
            }));
        }
    } catch (_) { /* fail-soft — never break the panel */ }

    return {
        orgId,
        allowedBetaFeatures,
        enabledBetaFeatures: betaGoverned ? allowedBetaFeatures : enabledBetaFeatures,
        allowedIntegrations: planCappedInt, enabledIntegrations,
        customIntegrations,
        betaRegistry: await visibleBetaRegistry(),
        betaGoverned,
    };
}

/** Permission check shared by both /me routes. */
async function requireOrgAdminLike(req, res) {
    const userId = req.session?.user?.id;
    if (!userId) { res.status(401).json({ error: 'Not authenticated' }); return false; }
    if (req.session.isAdmin || req.session.user?.role === 'admin') return true;
    const perms = await getUserPermissions(userId, req.session);
    if (perms.includes('all') || perms.includes('org_admin')) return true;
    res.status(403).json({ error: 'Organization admin access required' });
    return false;
}

router.get('/me/active-features', requireAuth, async (req, res) => {
    if (!(await requireOrgAdminLike(req, res))) return;
    const ctx = await resolveActiveFeaturesContext(req);
    res.json(ctx);
});

router.put('/me/active-features', requireAuth, validate({ body: ActiveFeaturesBody }), async (req, res) => {
    if (!(await requireOrgAdminLike(req, res))) return;
    const { betaEnabled, integrationsEnabled } = req.body;
    const ctx = await resolveActiveFeaturesContext(req);
    if (!ctx.orgId) return res.status(400).json({ error: 'No organisation to update' });

    // Snapshot the current enablement state so the audit row captures the
    // actual transition rather than just the new value.
    const prevBeta = Array.isArray(ctx.enabledBetaFeatures) ? [...ctx.enabledBetaFeatures] : [];
    const prevInt = Array.isArray(ctx.enabledIntegrations) ? [...ctx.enabledIntegrations] : [];
    let savedBeta = ctx.enabledBetaFeatures;
    let savedInt = ctx.enabledIntegrations;

    // Plan caps — an org-admin cannot enable beyond what the plan allows.
    // null cap = unrestricted (legacy plans without the column set).
    const planEntitlements = require('../../services/planEntitlements');
    const caps = await planEntitlements.getOrgCaps(ctx.orgId);

    // On cloud the subscription governs beta access — ignore any beta
    // changes (the panel renders that tab read-only). Integration toggles
    // below still apply. Self-hosted keeps the org-admin opt-in.
    if (Array.isArray(betaEnabled) && !ctx.betaGoverned) {
        // ctx.allowedBetaFeatures is already the authoritative ceiling:
        // super-admin grants override the plan cap, and freeForAll
        // defaults are pre-intersected with the cap. No second cap pass.
        const allowedSet = new Set(ctx.allowedBetaFeatures);
        const clean = Array.from(new Set(betaEnabled.filter(id => allowedSet.has(id))));
        if (!(await userStore.setOrgEnabledBetaFeatures(ctx.orgId, clean))) {
            return res.status(500).json({ error: 'Failed to save beta features' });
        }
        savedBeta = clean;
    }

    if (Array.isArray(integrationsEnabled)) {
        const allowedSet = new Set(ctx.allowedIntegrations);
        let clean = Array.from(new Set(integrationsEnabled.filter(id => allowedSet.has(id))));
        clean = planEntitlements.applyCap(clean, caps.integrations);
        if (!(await userStore.setOrgEnabledIntegrations(ctx.orgId, clean))) {
            return res.status(500).json({ error: 'Failed to save integrations' });
        }
        savedInt = clean;
    }

    // GDPR Art. 30 / SOC 2 — every entitlement mutation needs an audit row.
    // Only fire when at least one of the lists actually changed.
    const betaChanged = Array.isArray(betaEnabled) && JSON.stringify([...prevBeta].sort()) !== JSON.stringify([...savedBeta].sort());
    const intChanged = Array.isArray(integrationsEnabled) && JSON.stringify([...prevInt].sort()) !== JSON.stringify([...savedInt].sort());
    if (betaChanged || intChanged) {
        const oldVals = {};
        const newVals = {};
        if (betaChanged) { oldVals.betaEnabled = prevBeta; newVals.betaEnabled = savedBeta; }
        if (intChanged) { oldVals.integrationsEnabled = prevInt; newVals.integrationsEnabled = savedInt; }
        try {
            await userStore.logAccessAudit(
                'org.active_features.update',
                'organization',
                ctx.orgId,
                req.session.user?.id || null,
                oldVals,
                newVals,
                ctx.orgId,
            );
        } catch (e) {
            log.warn('[ActiveFeatures] audit log failed:', e.message);
        }
    }

    res.json({ orgId: ctx.orgId, enabledBetaFeatures: savedBeta, enabledIntegrations: savedInt });
});

// ── Unified entitlements (the single client snapshot + Access matrix) ─────
// GET /auth/my-entitlements — one read for the whole SPA. Supersedes the read
// side of /api/license/status + /auth/my-permissions + /auth/me/active-features.
router.get('/my-entitlements', requireAuth, async (req, res) => {
    const entitlements = require('../../core/entitlements/entitlements');
    const snap = await entitlements.resolveEntitlements({
        userId: req.session.user?.id,
        orgId: req.session.user?.organizationId || req.session.user?.orgId || null,
        session: req.session,
        req,
    });
    const { _sets, ...pub } = snap;
    res.json({
        ...pub,
        registry: entitlements.registry.listCapabilities().map(c => ({
            id: c.id, kind: c.kind, name: c.name, description: c.description,
            category: c.category, lifecycle: c.lifecycle, userFacing: c.userFacing,
            // licenseFeature lets the SPA resolve legacy licence-feature names
            // to their capability id so hasFeature()/can() accept either
            // namespace and agree with the server gate.
            licenseFeature: c.licenseFeature || null,
            // Owning platform module (server/modules), null for the
            // non-modular majority — lets the SPA badge modular features.
            moduleId: c.moduleId || null,
        })),
    });
});

// Resolve the ORG-scoped entitlement snapshot (ceiling + actual org-wide grants)
// independent of who is asking — uses the org's own tier, never the caller's
// (super-admin) elevated tier, so the matrix shows the real org state.
async function resolveOrgEntitlementSnapshot(orgId) {
    const entitlements = require('../../core/entitlements/entitlements');
    return entitlements.resolveEntitlements({ userId: null, orgId, session: null, req: null });
}

function unionKindArrays(kindObj) {
    return [...(kindObj.core || []), ...(kindObj.beta || []), ...(kindObj.integration || [])];
}

// Shared builder for the "Access & Permissions" matrix payload (org-scoped).
async function buildGroupAccessResponse(orgId) {
    const entitlements = require('../../core/entitlements/entitlements');
    const snap = await resolveOrgEntitlementSnapshot(orgId);
    // Ensure installed MCP servers are projected as integration capabilities so
    // they appear in the matrix (even if the snapshot above was degraded/cached).
    await entitlements.registry.refreshMcpIntegrationDescriptors();
    // …and drop capabilities of un-imported platform modules from the matrix.
    await entitlements.registry.refreshModuleCapabilityFilter();
    const matrixCaps = entitlements.registry.listCapabilities().filter(c => c.userFacing && c.groupTogglable);
    const capIdSet = new Set(matrixCaps.map(c => c.id));
    // groupScoped tells the matrix that this beta is NOT tied to the org-access
    // menu: "All members" is a real toggle for it (in both modes, the plan stays
    // the ceiling) and a group can hold it on its own.
    const capabilities = matrixCaps.map(c => ({ id: c.id, kind: c.kind, name: c.name, description: c.description, category: c.category, lifecycle: c.lifecycle, groupScoped: !!c.groupScoped }));
    const allGroups = await userStore.getAllGroups();
    const groups = allGroups
        .filter(g => g.organizationId === orgId)
        .map(g => ({ id: g.id, name: g.name, granted: (Array.isArray(g.granted_capabilities) ? g.granted_capabilities : []).filter(id => capIdSet.has(id)) }));
    // Keep ceiling/everyone consistent with the matrix-visible capabilities
    // (excludes NC family + exempt + infra core, which aren't toggled here).
    const inMatrix = (ids) => unionKindArrays(ids).filter(id => capIdSet.has(id));
    return {
        orgId,
        mode: snap.mode,
        capabilities,
        // The distribution matrix is bounded by the org's ACCESS MENU
        // (orgAvailable), not the raw plan/license ceiling: an org-admin can only
        // grant what the org has been given access to. Locked rows = outside the
        // menu. The super-admin sets the menu in the Organisation access surface.
        ceiling: inMatrix(snap.orgAvailable),
        // For a group-scoped beta this reflects org_beta_everyone (buildOrgGrant
        // reads it), so the "All members" toggle shows what is stored.
        everyone: inMatrix(snap.orgEnabled),
        groups,
        // On cloud the subscription governs which betas the org has; the beta
        // "All members" column is plan-driven (read-only). Integrations (incl.
        // MCP servers) and core are org + per-group distributable in both modes.
        betaGoverned: snap.mode === 'cloud',
    };
}

// Shared writer for the org-wide "All members" grants (clamped to ceiling).
async function writeOrgAccessGrants(orgId, granted, actorId) {
    const entitlements = require('../../core/entitlements/entitlements');
    const snap = await resolveOrgEntitlementSnapshot(orgId);
    await entitlements.registry.refreshMcpIntegrationDescriptors(); // so getCapability('mcp:x') resolves
    // Clamp to the org's ACCESS MENU (orgAvailable), not the raw ceiling, so an
    // org-admin's "All members" grants can never exceed the org's access.
    const bound = snap.orgAvailable;
    // MCP servers have kind 'integration' now → they land in buckets.integration
    // and persist via setOrgEnabledIntegrations, like every other integration.
    const buckets = { core: [], beta: [], integration: [] };
    for (const capId of granted) {
        const cap = entitlements.registry.getCapability(capId);
        if (!cap || !cap.groupTogglable) continue;
        if (!bound[cap.kind] || !bound[cap.kind].includes(capId)) continue; // server-side clamp
        buckets[cap.kind].push(capId);
    }
    // Org-scoped custom integrations ('custom:<uuid>': AI-builder rows and the
    // MCP library's remote servers) are never rows of this matrix
    // (capabilityRegistry keeps them out of listCapabilities), so a save cannot
    // have decided them. Replacing the list wholesale used to revoke every one
    // of them for "All members" on any unrelated toggle; keep them as stored.
    // Their own surfaces (the MCP library) grant and revoke them.
    let storedIntegrations = [];
    try { storedIntegrations = await userStore.getOrgEnabledIntegrations(orgId); } catch (_) { /* nothing to keep */ }
    const keptCustom = (Array.isArray(storedIntegrations) ? storedIntegrations : [])
        .filter(id => typeof id === 'string' && id.startsWith('custom:') && !buckets.integration.includes(id));
    await userStore.setOrgEnabledIntegrations(orgId, [...buckets.integration, ...keptCustom]); // NC bypasses; MCP included
    if (snap.mode !== 'cloud') await userStore.setOrgEnabledBetaFeatures(orgId, buckets.beta); // cloud betas governed
    // Group-scoped betas: the everyone-choice is stored in BOTH modes (on cloud
    // the subscription stays the ceiling, it just no longer decides who inside
    // the org gets it).
    const prevEveryone = await userStore.getOrgBetaEveryone(orgId);
    const nextEveryone = await nextBetaEveryone(orgId, bound, buckets.beta, entitlements.registry);
    await userStore.setOrgBetaEveryone(orgId, nextEveryone);
    // "All members" meeting_notes implies use_meeting_notes (permissions.orgWideGrantImpliedPermissions):
    // cached permission sets are stale once it flips, as for a group grant. null = everyone.
    const isEveryone = (list, capId) => list == null || list.includes(capId);
    const flipped = Object.keys(GROUP_GRANT_IMPLIED_PERMISSIONS).some(capId => isEveryone(prevEveryone, capId) !== isEveryone(nextEveryone, capId));
    if (flipped) await invalidateAllPermissionCaches().catch(e => log.warn('[Entitlements] permission cache invalidation failed:', e.message));
    // Self-hosted: the "All members" switch-off is a deny-list the resolver reads
    // (buildOrgGrant). The writes around it stay so switching modes is lossless.
    if (snap.mode !== 'cloud') {
        await userStore.setOrgEveryoneRevoked(orgId, await nextEveryoneRevoked(orgId, bound, buckets, entitlements.registry));
    }
    await userStore.setOrgGrantedCapabilities(orgId, [...buckets.core]);
    await entitlements.invalidateForOrg(orgId);
    try {
        await userStore.logAccessAudit('org.access.update', 'organization', orgId, actorId || null, {}, { granted }, orgId);
    } catch (e) { log.warn('[Entitlements] org-access audit failed:', e.message); }
    return [...buckets.integration, ...buckets.beta, ...buckets.core];
}

// GET /auth/me/group-access — matrix data for the caller's own organisation.
router.get('/me/group-access', requireAuth, async (req, res) => {
    if (!(await requireOrgAdminLike(req, res))) return;
    const ctx = await resolveActiveFeaturesContext(req);
    if (!ctx.orgId) {
        return res.json({ orgId: null, mode: betaGovernedBySubscription() ? 'cloud' : 'self-hosted', capabilities: [], ceiling: [], everyone: [], groups: [], betaGoverned: betaGovernedBySubscription() });
    }
    res.json(await buildGroupAccessResponse(ctx.orgId));
});

// PUT /auth/me/org-access — write the caller's org-wide "All members" grants.
router.put('/me/org-access', requireAuth, validate({ body: GrantedBody }), async (req, res) => {
    if (!(await requireOrgAdminLike(req, res))) return;
    const { granted } = req.body;
    const ctx = await resolveActiveFeaturesContext(req);
    if (!ctx.orgId) return res.status(400).json({ error: 'No organisation to update' });
    const everyone = await writeOrgAccessGrants(ctx.orgId, granted, req.session.user?.id);
    res.json({ success: true, everyone });
});

// Org-scoped variants for the super-admin Beheerdashboard (manage any org).
// requireOrgAdmin('orgId') passes for super-admins and for that org's admins.
router.get('/organizations/:orgId/group-access', requireOrgAdmin('orgId'), async (req, res) => {
    res.json(await buildGroupAccessResponse(req.params.orgId));
});

router.put('/organizations/:orgId/org-access', requireOrgAdmin('orgId'), validate({ body: GrantedBody }), async (req, res) => {
    const { granted } = req.body;
    const everyone = await writeOrgAccessGrants(req.params.orgId, granted, req.session.user?.id);
    res.json({ success: true, everyone });
});

// ── Organisation access menu (super-admin only) ──────────────────────────────
// The per-org set of capabilities the org MAY use, within the plan/license
// ceiling. This is the upper bound the org-admin distributes within (it is NOT
// a grant). Only a platform super-admin can change it.
// Named assertSuperAdmin, not requireSuperAdmin: this is an in-handler
// predicate that writes the 403 itself and returns a boolean, which is a
// different shape from the requireSuperAdmin MIDDLEWARE imported at the top of
// this file. Sharing the name shadowed the import.
function assertSuperAdmin(req, res) {
    const ok = req.session?.isAdmin || req.session?.user?.role === 'admin';
    if (!ok) { res.status(403).json({ error: 'Super-admin access required' }); return false; }
    return true;
}

async function buildOrgAvailabilityResponse(orgId) {
    const entitlements = require('../../core/entitlements/entitlements');
    const snap = await resolveOrgEntitlementSnapshot(orgId);
    await entitlements.registry.refreshMcpIntegrationDescriptors(); // MCP servers as integration caps
    await entitlements.registry.refreshModuleCapabilityFilter();    // drop un-imported module caps
    const matrixCaps = entitlements.registry.listCapabilities().filter(c => c.userFacing && c.groupTogglable);
    const capIdSet = new Set(matrixCaps.map(c => c.id));
    const capabilities = matrixCaps.map(c => ({ id: c.id, kind: c.kind, name: c.name, description: c.description, category: c.category, lifecycle: c.lifecycle }));
    const inMatrix = (ids) => unionKindArrays(ids).filter(id => capIdSet.has(id));
    const stored = await userStore.getOrgAvailableCapabilities(orgId); // null = unrestricted
    return {
        orgId,
        mode: snap.mode,
        capabilities,
        ceiling: inMatrix(snap.ceiling),     // the full plan/license menu to choose from
        available: inMatrix(snap.orgAvailable), // what the org may currently use
        unrestricted: stored == null,
    };
}

router.get('/organizations/:orgId/org-availability', requireOrgAdmin('orgId'), async (req, res) => {
    if (!assertSuperAdmin(req, res)) return;
    res.json(await buildOrgAvailabilityResponse(req.params.orgId));
});

router.put('/organizations/:orgId/org-availability', requireOrgAdmin('orgId'), validate({ body: OrgAvailabilityBody }), async (req, res) => {
    if (!assertSuperAdmin(req, res)) return;
    const orgId = req.params.orgId;
    const entitlements = require('../../core/entitlements/entitlements');
    const { available, unrestricted } = req.body;
    if (unrestricted === true) {
        await userStore.setOrgAvailableCapabilities(orgId, null); // clear → org may use everything in ceiling
    } else {
        if (!Array.isArray(available)) return res.status(400).json({ error: 'available must be an array of capability ids (or pass unrestricted:true)' });
        // Clamp to the plan/license ceiling + matrix-visible togglable caps.
        const snap = await resolveOrgEntitlementSnapshot(orgId);
        const ceilingSet = new Set(unionKindArrays(snap.ceiling));
        const clean = Array.from(new Set(available.filter(capId => {
            const cap = entitlements.registry.getCapability(capId);
            return cap && cap.userFacing && cap.groupTogglable && ceilingSet.has(capId);
        })));
        await userStore.setOrgAvailableCapabilities(orgId, clean);
    }
    await entitlements.invalidateForOrg(orgId);
    // Also drop the EDITING admin's own per-request entitlement cache: a global
    // admin isn't a member of `orgId`, so invalidateForOrg won't bust their
    // session — without this their own Studio would lag the change by the cache
    // TTL even after the UI reloads entitlements.
    for (const k of Object.keys(req.session)) if (k.startsWith('_ent:')) delete req.session[k];
    try {
        await userStore.logAccessAudit('org.availability.update', 'organization', orgId, req.session.user?.id || null, {}, { available: unrestricted === true ? null : available }, orgId);
    } catch (e) { log.warn('[Entitlements] org-availability audit failed:', e.message); }
    res.json(await buildOrgAvailabilityResponse(orgId));
});

// PUT /auth/admin/selected-org — persist the Access org-picker selection on the
// session so a GLOBAL super-admin (organizationId=null) has their OWN entitlement
// resolution governed by the org they're administering (see governingOrgId in
// entitlements.resolveEntitlements). Without this a no-org admin escapes every
// per-org access menu. Session-only; super-admin gated.
router.put('/admin/selected-org', requireAuth, validate({ body: SelectedOrgBody }), async (req, res) => {
    if (!assertSuperAdmin(req, res)) return;
    const { orgId } = req.body;
    const clearCache = () => { for (const k of Object.keys(req.session)) if (k.startsWith('_ent:')) delete req.session[k]; };
    if (orgId == null || orgId === '') {
        delete req.session.adminSelectedOrgId;
        clearCache();
        return res.json({ success: true, adminSelectedOrgId: null });
    }
    const org = await userStore.getOrganization(orgId);
    if (!org) return res.status(404).json({ error: 'organization_not_found' });
    req.session.adminSelectedOrgId = orgId;
    clearCache(); // drop the admin's cached snapshot so the new scope applies immediately
    res.json({ success: true, adminSelectedOrgId: orgId });
});

// PUT /auth/groups/:id/access — write a single group's grants (clamped to the
// registry + the org access menu). Grant-only; a grant can never exceed it.
router.put('/groups/:id/access', requireAuth, validate({ body: GrantedBody }), async (req, res) => {
    const { id } = req.params;
    const { granted } = req.body;
    const userId = req.session.user?.id;
    const isSuperAdmin = req.session.isAdmin || req.session.user?.role === 'admin';
    const allGroups = await userStore.getAllGroups();
    const group = allGroups.find(g => g.id === id);
    if (!group) return res.status(404).json({ error: 'Group not found' });
    if (!isSuperAdmin) {
        const perms = await getUserPermissions(userId, req.session);
        const me = await userStore.getUser(userId);
        if (!(perms.includes('all') || perms.includes('org_admin')) || me?.organizationId !== group.organizationId) {
            return res.status(403).json({ error: 'Organization admin access required' });
        }
    }
    const entitlements = require('../../core/entitlements/entitlements');
    const snap = await resolveOrgEntitlementSnapshot(group.organizationId);
    // Clamp per-group grants to the org's ACCESS MENU (orgAvailable), so a
    // group can never be granted a capability the org has no access to.
    const boundSet = new Set(unionKindArrays(snap.orgAvailable));
    const clean = Array.from(new Set(granted.filter(capId => {
        const cap = entitlements.registry.getCapability(capId);
        return cap && cap.groupTogglable && boundSet.has(capId);
    })));
    const prev = Array.isArray(group.granted_capabilities) ? group.granted_capabilities : [];
    // Org-scoped custom integrations are not matrix rows, so this save did not
    // decide them (see writeOrgAccessGrants): carry them over as stored.
    for (const capId of prev) {
        if (typeof capId === 'string' && capId.startsWith('custom:') && !clean.includes(capId)) clean.push(capId);
    }
    if (!(await userStore.updateGroup(id, { grantedCapabilities: clean }))) {
        return res.status(404).json({ error: 'Group not found' });
    }
    try {
        await userStore.logAccessAudit('group.access.update', 'group', id, userId || null, { grantedCapabilities: prev }, { grantedCapabilities: clean }, group.organizationId || null);
    } catch (e) { log.warn('[Entitlements] group-access audit failed:', e.message); }
    await entitlements.invalidateForOrg(group.organizationId);
    // A grant such as meeting_notes carries a UI permission to the group's
    // members (getUserPermissions), so their cached permission sets are stale
    // the moment such a grant flips.
    const implied = Object.keys(GROUP_GRANT_IMPLIED_PERMISSIONS);
    if (implied.some(capId => prev.includes(capId) !== clean.includes(capId))) {
        try { await invalidateAllPermissionCaches(); } catch (e) { log.warn('[Entitlements] permission cache invalidation failed:', e.message); }
    }
    res.json({ success: true, granted: clean });
});

// ── Consumer beta-features (no org) ──────────────────────────────
// Consumer accounts have no organisation, so /me/active-features above
// returns an empty payload for them. Beta grants for consumer users are
// configured deployment-wide in `default_consumer_beta_features` (super
// admin only). This route exposes the resolved list so the personal
// "Beta features" panel can render. Read-only — consumers cannot toggle.
router.get('/me/consumer-features', requireAuth, async (req, res) => {
    const userId = req.session?.user?.id;
    if (!userId) return res.status(401).json({ error: 'Not authenticated' });
    const raw = await require('../../stores/configStore').getConfig('default_consumer_beta_features');
    const allowedBetaFeatures = Array.isArray(raw) ? raw : [];
    res.json({ allowedBetaFeatures, betaRegistry: await visibleBetaRegistry() });
});

module.exports = router;
