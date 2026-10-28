// @typecheck noImplicitAny
/**
 * Nextcloud Connector: what binding a Nextcloud to an organisation provisions.
 *
 *   - the provisioning mode (may an unknown Nextcloud create a fresh org?);
 *   - the default plan an NC org starts on;
 *   - the per-org tenant key the connector signs with;
 *   - the NC admins as org admins;
 *   - binding an existing org to an NC instance.
 *
 * Used by the bootstrap branches (connector/bootstrapBranches.js), the
 * verification route in auth/connectorBootstrap.js and, through that file's
 * `helpers`, by ncBindingRoutes.js and connectorJwt.js.
 */

const crypto = require('crypto');
const log = require('../../telemetry/log');
const { fallback } = require('../../utils/bestEffort');
const userStore = require('../../stores/userStore');
const configStore = require('../../stores/configStore');
const { invalidateTenantKeyCache } = require('../connectorJwt');
const { orgHealth, planEntitlements } = require('./serviceDeps');
const { NC_INTEGRATION_IDS } = require('../../utils/ncIntegrationCatalog');

/** @typedef {NonNullable<Awaited<ReturnType<typeof userStore.getOrganization>>>} OrgRow */

// Auto-apply the operator-flagged "Nextcloud recommended" plan to freshly
// provisioned or freshly-adopted NC orgs so they get enterprise-equivalent
// entitlements (Webpages, Meeting Notes, Automations, …) without manual
// intervention. Without this the org defaults to the community tier and the
// admin lands on a stripped-down SPA on their first visit. Best-effort — a
// failure logs and continues; the org is still usable on the community
// fallback.
/**
 * @param {string} orgId
 * @param {string} source
 */
async function applyNcDefaultPlanIfConfigured(orgId, source) {
    try {
        const plan = await userStore.getDefaultNcPlan();
        let planId = plan?.id || null;
        let fallback = false;
        if (!planId) {
            // No NC-recommended plan configured. If the org already has a
            // subscription row (createOrganization pre-assigns the `is_default`
            // plan since BFSF-226, or an admin picked one), leave it alone.
            const existing = await userStore.getOrgSubscription(orgId);
            if (existing) {
                log.info(`[ConnectorBootstrap] no NC-recommended plan configured; org ${orgId} keeps existing subscription plan=${existing.plan_id} (source=${source})`);
                return;
            }
            // Fallback: the operator's default org plan — plan defaults only, no
            // entitlements reset (applyPlanToOrg stays NC-plan-only). This closes
            // the gap where adopted/pre-BFSF-226 orgs ended up with NO
            // subscription row and every chat 403'd on cloud.
            planId = await userStore.getDefaultOrgPlanId();
            fallback = true;
            if (!planId) {
                log.info(`[ConnectorBootstrap] no NC-recommended plan configured; org ${orgId} will use community fallback (source=${source})`);
                orgHealth.problem('bootstrap.community_fallback', {
                    orgId, source: 'connectorBootstrap',
                    meta: { source, reason: 'no_nc_recommended_plan_and_no_default' },
                });
                return;
            }
        }
        // Make it the org's ACTIVE subscription — createOrganization pre-assigns
        // the `is_default` plan, so without this the org would keep that plan and
        // only inherit this plan's integrations/features. setOrgSubscription
        // upserts the organization_subscriptions row so billing/limits read the
        // NC plan. Then applyPlanToOrg syncs the enabled integrations/features
        // (nc_recommended case only — the fallback path applies plan defaults
        // without touching hand-configured org integrations).
        await userStore.setOrgSubscription(orgId, { plan_id: planId, status: 'active' });
        if (!fallback) {
            await planEntitlements.applyPlanToOrg(orgId, planId, { mode: 'reset' });
        }
        log.info(`[ConnectorBootstrap] Applied ${fallback ? 'default org' : 'NC default'} plan ${planId}${plan?.name ? ` (${plan.name})` : ''} as active subscription for org ${orgId} (source=${source})`);
        // Audit trail (best-effort; logAccessAudit never throws) — metadata only.
        await userStore.logAccessAudit('nc_default_plan_applied', 'organization', orgId,
            'system:connector_bootstrap', null, { plan_id: planId, source, fallback }, orgId);
        orgHealth.event('bootstrap.plan_applied', { orgId, meta: { planId, fallback } });
        orgHealth.resolve(orgId, ['bootstrap.community_fallback', 'chat.subscription_blocked']);
    } catch (err) {
        log.warn(`[ConnectorBootstrap] failed to apply NC default plan to org ${orgId}: ${err.message}`);
        orgHealth.problem('bootstrap.plan_apply_failed', {
            orgId, source: 'connectorBootstrap', meta: { source, error: err },
        });
    }
}

const TENANT_KEY_PREFIX = 'connector_tenant_key_';

// ── Connector provisioning policy ──────────────────────────────────────────
// Gate on the fresh-org branch: may an *unknown* Nextcloud (no existing bind,
// no valid pairing code, no email-domain match) auto-create a brand-new org?
// This is the control that stops "anyone who knows the server address can mint
// an organisation on it". Resolution order: super-admin config key → env →
// deployment default. Returning binds, pairing codes and email-domain adoption
// are NOT affected by this — they have their own authorisation proof.
//   - open:         fresh-org allowed (zero-touch one-click). Cloud default.
//   - pairing_only: fresh-org refused (403 pairing_required). Self-host default.
// Unknown/invalid values fail closed to pairing_only.
const PROVISIONING_MODES = ['open', 'pairing_only'];

// Hosts that are the official Bee Flow Cloud control plane. These default to
// `open` so the App Store install stays zero-touch; every other deployment
// (i.e. self-hosted) defaults to `pairing_only`.
const CLOUD_PROVISIONING_HOSTS = new Set([
    'server.beeflow.nl', 'server.dev.beeflow.nl',
]);

function defaultProvisioningMode() {
    const host = String(process.env.SERVER_PUBLIC_HOST || '').trim().toLowerCase();
    return CLOUD_PROVISIONING_HOSTS.has(host) ? 'open' : 'pairing_only';
}

// Resolve the effective provisioning mode. The DB-backed super-admin key wins
// (an operator can flip it at runtime without a redeploy — same mechanism as
// default_org_integrations), then the env override, then the deployment
// default. Anything unrecognised fails closed.
async function resolveProvisioningMode() {
    let mode;
    try {
        mode = await configStore.getConfig('connector_provisioning_mode');
    } catch (err) {
        // The operator's stored mode is unknown: never fall back to a default that may be 'open'.
        return fallback('connectorProvisioning:mode-read', err, 'pairing_only');
    }
    if (!mode) mode = (process.env.BEEFLOW_CONNECTOR_PROVISIONING || '').trim() || null;
    if (!mode) mode = defaultProvisioningMode();
    mode = String(mode).trim().toLowerCase();
    if (!PROVISIONING_MODES.includes(mode)) {
        log.warn(`[ConnectorBootstrap] unknown provisioning mode '${mode}' — failing closed to pairing_only`);
        return 'pairing_only';
    }
    return mode;
}

// All NC integrations Bee Flow ships with — auto-enabled on connector
// bootstrap so the agent can immediately reach Files, Calendar, Mail, etc.
// out-of-the-box without an org-admin having to flip toggles. The connector
// proxy handles auth via AppAPI shared-secret + impersonation, so no
// per-user app passwords are needed.
// From the catalog, not a hand-maintained copy: the local list had drifted to
// 10 of the 14 ids (mail, tables, forms and teams were missing), so a freshly
// bootstrapped org silently started without them.
const NC_INTEGRATIONS = NC_INTEGRATION_IDS.slice();

/**
 * @param {unknown} s
 */
function slugify(s) {
    return String(s || 'nc')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 40) || 'nc';
}

// Mint or fetch the tenantKey for an org. Idempotent — re-runs return the
// same key. Used by the bootstrap branches, the verification route and the
// approval handler in ncBindingRoutes.js.
/**
 * @param {string} orgId
 */
async function getOrMintTenantKey(orgId) {
    const cfgKey = `${TENANT_KEY_PREFIX}${orgId}`;
    const existing = await configStore.getSecret(cfgKey);
    if (existing) return existing;
    // Atomic mint: concurrent bootstraps (across replicas) each generate a
    // candidate, but setSecretIfAbsent only stores the first and returns the
    // authoritative winner to ALL callers — so the connector receives one
    // consistent key no matter how many POSTs it sent. Without this, parallel
    // mints + last-write-wins left the connector cache and the DB on different
    // keys → every per-user JWT 403'd.
    const candidate = crypto.randomBytes(32).toString('base64url');
    const stored = await configStore.setSecretIfAbsent(cfgKey, candidate);
    invalidateTenantKeyCache(orgId);
    if (stored === candidate) {
        log.info(`[ConnectorBootstrap] Minted new tenant key for org ${orgId}`);
    } else {
        log.info(`[ConnectorBootstrap] Adopted concurrently-minted tenant key for org ${orgId}`);
    }
    return stored || candidate;
}

// Promote / create the NC admin user inside an org. Used by the fresh-org
// branch and the approval handler.
/**
 * @param {OrgRow} org
 * @param {{ ncAdminEmail: string, ncAdminUid: string, ncAdminDisplayName?: string|null }} admin
 */
async function ensureOrgAdminUser(org, { ncAdminEmail, ncAdminUid, ncAdminDisplayName }) {
    let user = await userStore.getUserByEmail(ncAdminEmail);
    if (!user) {
        const userId = `nc_${org.id}_${slugify(ncAdminUid)}`;
        const r = await userStore.createUserWithSeatCheck({
            id: userId,
            username: ncAdminEmail,
            email: ncAdminEmail,
            displayName: ncAdminDisplayName || ncAdminUid,
            role: 'user',
            orgRole: 'org_admin',
            organizationId: org.id,
            ncUid: ncAdminUid,
            provider: 'nextcloud_connector',
            autoProvisioned: true,
            status: 'active',
        }, { strict: false });
        if (!r.created) {
            log.warn(`[connectorBootstrap] could not create NC admin for org=${org.id} reason=${r.reason}`);
            orgHealth.problem('bootstrap.admin_provision_failed', {
                orgId: org.id, source: 'connectorBootstrap',
                meta: { reason: r.reason },
            });
            return null;
        }
        return await userStore.getUser(userId);
    }
    if (user.organizationId && user.organizationId !== org.id) {
        const userOrg = await userStore.getOrganization(user.organizationId);
        if (!userOrg) {
            // Orphaned — rebind.
            await userStore.updateUser(user.id, {
                organizationId: org.id,
                orgRole: 'org_admin',
                ncUid: user.nc_uid || ncAdminUid,
                provider: user.provider || 'nextcloud_connector',
            });
            log.info(`[ConnectorBootstrap] Rebound orphaned user ${user.id} to org ${org.id}`);
            return await userStore.getUser(user.id);
        }
        const err = new Error('NC admin email is linked to another Bee Flow organization');
        err.statusCode = 409;
        throw err;
    }
    const updates = {};
    if (!user.organizationId) updates.organizationId = org.id;
    if (user.orgRole !== 'org_admin') updates.orgRole = 'org_admin';
    // Raw row spelling is nc_uid — checking only the camelCase alias made this
    // guard always-true, so every bootstrap stamped admins[0]'s uid over the
    // existing binding (and connectorJwt prefers the stored uid → the user
    // then impersonated the wrong NC account on WebDAV). Set only when absent.
    if (!(user.nc_uid || user.ncUid)) updates.ncUid = ncAdminUid;
    if (!user.provider) updates.provider = 'nextcloud_connector';
    if (Object.keys(updates).length > 0) await userStore.updateUser(user.id, updates);
    return await userStore.getUser(user.id);
}

// Best-effort provision EVERY other NC admin (besides the primary, already
// ensured by the caller) as an org_admin, so any admin — not just the one who
// installed — can onboard/use Bee Flow. `ncAdmins` is the list the connector
// (v≥0.1.35) sends in the bootstrap body; older connectors omit it and we no-op.
// Per-admin failures are logged and SKIPPED — a seat-cap or a cross-org email
// conflict on a secondary admin must never fail the whole install. Admins count
// as normal seats: ensureOrgAdminUser → createUserWithSeatCheck enforces the cap,
// so over-cap admins are simply not created (and surface the same way standalone).
// Pure: the secondary admins worth provisioning — trimmed, lower-cased email,
// deduped by uid, with the primary and any email-less entry dropped. Exported
// for unit tests.
/**
 * @param {unknown} ncAdmins
 * @param {string} primaryUid
 */
function _selectSecondaryAdmins(ncAdmins, primaryUid) {
    if (!Array.isArray(ncAdmins)) return [];
    const seen = new Set();
    const out = [];
    for (const a of ncAdmins) {
        const uid = String(a?.uid || '').trim();
        const email = String(a?.email || '').trim().toLowerCase();
        if (!uid || !email || uid === primaryUid || seen.has(uid)) continue;
        seen.add(uid);
        out.push({ uid, email, displayName: String(a?.displayName || '').trim() || uid });
    }
    return out;
}

/**
 * @param {OrgRow} org
 * @param {unknown} ncAdmins
 * @param {string} primaryUid
 */
async function ensureAdditionalOrgAdmins(org, ncAdmins, primaryUid) {
    for (const a of _selectSecondaryAdmins(ncAdmins, primaryUid)) {
        try {
            await ensureOrgAdminUser(org, {
                ncAdminEmail: a.email,
                ncAdminUid: a.uid,
                ncAdminDisplayName: a.displayName,
            });
        } catch (e) {
            log.warn(`[ConnectorBootstrap] skipped extra NC admin ${a.uid} for org ${org.id}: ${e.message}`);
        }
    }
}

// Bind an existing un-bound org to this NC instance. Used by the approval
// handler in ncBindingRoutes.js.
/**
 * @param {OrgRow} org
 * @param {{ ncInstanceId: string, ncBaseUrl: string, ncAdminUid: string, connectorCallbackUrl?: string|null }} params
 */
async function bindOrgToNcInstance(org, params) {
    const { ncInstanceId, ncBaseUrl, ncAdminUid, connectorCallbackUrl } = params;
    let existingIntegrations = [];
    if (Array.isArray(org.enabledIntegrations)) {
        existingIntegrations = org.enabledIntegrations;
    } else if (typeof org.enabledIntegrations === 'string' && org.enabledIntegrations) {
        try { existingIntegrations = JSON.parse(org.enabledIntegrations) || []; } catch (_) { existingIntegrations = []; }
    }
    const merged = Array.from(new Set([...existingIntegrations, ...NC_INTEGRATIONS]));
    await userStore.updateOrganization(org.id, {
        authMethod: 'nextcloud_connector',
        autoApproveSSO: true,
        connectorCallbackUrl: connectorCallbackUrl || null,
        ncInstanceId,
        ncBaseUrl,
        ncAdminUid,
        ncProvisionedAt: new Date().toISOString(),
        enabledIntegrations: merged,
    });
    return await userStore.getOrganizationByNcInstanceId(ncInstanceId);
}


module.exports = {
    TENANT_KEY_PREFIX,
    PROVISIONING_MODES,
    NC_INTEGRATIONS,
    applyNcDefaultPlanIfConfigured,
    defaultProvisioningMode,
    resolveProvisioningMode,
    slugify,
    getOrMintTenantKey,
    ensureOrgAdminUser,
    _selectSecondaryAdmins,
    ensureAdditionalOrgAdmins,
    bindOrgToNcInstance,
};
