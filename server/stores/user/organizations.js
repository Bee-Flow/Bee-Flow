// @typecheck
// Organizations — CRUD, per-org capability/enablement lists, the org-deletion
// cascade, and the auto-provisioned NC org-name backfill.

const { run, getOne, getAll } = require('../../db');
const { initDB } = require('./schema');
const { dynamicUpdate, parseJSON } = require('./shared');
const { deleteUser, assertNotStageRunAs } = require('./users');
const { setOrgSubscription } = require('./subscriptions');
const { getDefaultOrgPlanId } = require('./billingLifecycle');
const log = require('../../telemetry/log');

// ── Organizations ─────────────────────────────
function parseOrg(o) {
    return {
        ...o,
        defaultGroups: parseJSON(o.defaultGroups, []),
        allowSignup: o.allowSignup === '1' || o.allowSignup === true,
        autoApproveSSO: o.autoApproveSSO === '1' || o.autoApproveSSO === true,
        // Structured billing address (legacy `address` is line1). camelCase
        // aliases so the frontend reads them the same way as address/kvk/vat.
        billingLine2: o.billing_line2 || '',
        billingPostalCode: o.billing_postal_code || '',
        billingCity: o.billing_city || '',
        billingCountry: o.billing_country || '',
        // Default '1' = pooled (matches legacy behaviour) when the column
        // is null on rows older than the migration.
        usagePooled: (o.usage_pooled ?? '1') !== '0',
        allowedDomains: parseJSON(o.allowed_domains, []),
        ncSyncGroups: parseJSON(o.nc_sync_groups, []),
        ncSyncExcludedGroups: parseJSON(o.nc_sync_excluded_groups, []),
        orgEnabledIntegrations: parseJSON(o.org_enabled_integrations, []),
        orgEnabledBetaFeatures: parseJSON(o.org_enabled_beta_features, []),
        orgGrantedCapabilities: parseJSON(o.org_granted_capabilities, []),
        // null = no restriction (org may use everything its ceiling allows).
        orgAvailableCapabilities: o.org_available_capabilities == null ? null : parseJSON(o.org_available_capabilities, null),
        // null = every group-scoped beta is on for all members (never chosen).
        orgBetaEveryone: o.org_beta_everyone == null ? null : parseJSON(o.org_beta_everyone, null),
        registrationSource: o.registration_source || null,
    };
}

async function getOrganizationByNcInstanceId(ncInstanceId) {
    if (!ncInstanceId) return null;
    await initDB();
    const o = await getOne('SELECT * FROM organizations WHERE nc_instance_id = $1', [ncInstanceId]);
    return o ? parseOrg(o) : null;
}

async function getAllOrganizations() {
    await initDB();
    // Deterministic order: callers that .find() a first match (e.g. email-domain
    // resolution) must not depend on undefined row ordering.
    const rows = await getAll('SELECT * FROM organizations ORDER BY id');
    return rows.map(parseOrg);
}

// Returns the single organisation's id iff EXACTLY one org exists (single-tenant
// self-hosted), else null. Cheap (no parseOrg, LIMIT 2) — used by the entitlements
// resolver to bind a no-org global admin to the only org's access ceiling.
async function getSingleOrgId() {
    await initDB();
    const rows = await getAll('SELECT id FROM organizations LIMIT 2');
    return rows.length === 1 ? rows[0].id : null;
}

/**
 * Does this installation have any organisation at all? The 'default' bucket
 * (users without an organisation) counts as an employee bucket for chat
 * signals only on an installation without one (amendment 18).
 * @returns {Promise<boolean>}
 */
async function hasAnyOrganization() {
    await initDB();
    const row = await getOne('SELECT 1 AS one FROM organizations LIMIT 1');
    return !!row;
}

// Find an un-bound organisation that "owns" an email domain, used by the
// connector bootstrap to route a same-domain Nextcloud install into the
// email-code verification flow (vs. creating a fresh org). Matches either an
// org_admin user whose email is at the domain, or an org whose admin-configured
// allowed_domains lists it. Callers MUST exclude free/public email providers
// before calling — this does not (a corporate domain implies the company
// controls its mailboxes). Returns null when nothing matches.
async function findUnboundOrgByEmailDomain(domain) {
    const d = String(domain || '').toLowerCase().trim();
    if (!d || !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(d)) return null;
    await initDB();
    const byAdmin = await getOne(
        `SELECT o.* FROM organizations o
         JOIN users u ON u."organizationId" = o.id
         WHERE u."orgRole" = 'org_admin'
           AND LOWER(u.email) LIKE '%@' || $1
           AND o.nc_instance_id IS NULL
         ORDER BY o.id ASC
         LIMIT 1`,
        [d]
    );
    if (byAdmin) return parseOrg(byAdmin);
    // allowed_domains is a JSON array string; match the quoted element so a
    // domain can't accidentally match as a substring of a longer one.
    const byAllowed = await getOne(
        `SELECT * FROM organizations
         WHERE nc_instance_id IS NULL
           AND allowed_domains IS NOT NULL
           AND allowed_domains ILIKE '%"' || $1 || '"%'
         ORDER BY id ASC
         LIMIT 1`,
        [d]
    );
    return byAllowed ? parseOrg(byAllowed) : null;
}

async function getOrganization(id) {
    await initDB();
    const o = await getOne('SELECT * FROM organizations WHERE id = $1', [id]);
    if (!o) return null;
    return parseOrg(o);
}

/**
 * The longest org id this deployment will store. Kept in step with
 * auth/accountProvisioning.MAX_ORG_ID_LENGTH, duplicated rather than imported
 * because that module requires userStore and the import would be a cycle.
 *
 * An org id is concatenated into Postgres identifiers, config keys and cache
 * keys throughout the codebase, and Postgres truncates every identifier to 63
 * bytes — quoted or not. Two ids sharing a long prefix then address the SAME
 * schema, the same config row, the same cache entry.
 */
const MAX_ORG_ID_LENGTH = 48;

/**
 * @param {object} orgData
 * @param {object} [opts]
 * @param {boolean} [opts.autoGrantTrial=true] Grant the configured org trial here.
 *   Web signup passes false and grants it from accountProvisioning.finalizeAccount
 *   instead, so org and consumer trials are granted at the same layer. Defaults to
 *   true so the connector bootstrap and admin org creation are unchanged.
 * @throws when `id` is longer than MAX_ORG_ID_LENGTH.
 */
async function createOrganization(orgData, { autoGrantTrial = true } = {}) {
    await initDB();
    const { id, name, description, tagline, address, email, phone, website, kvk, vat, logo, footerText, defaultGroups, allowSignup, authMethod, autoApproveSSO, enabledIntegrations, allowedDomains, ncInstanceId, ncBaseUrl, ncAdminUid, ncProvisionedAt, connectorCallbackUrl, registrationSource } = orgData;
    // Refused, never truncated. Truncating here would store an id the caller
    // does not have, and the caller is the thing that attaches the founding
    // user to it — they would land in an organisation that does not exist.
    // Every mint site caps its own slug (accountProvisioning.slugifyOrgId), so
    // this is the backstop for the next one that forgets.
    if (String(id || '').length > MAX_ORG_ID_LENGTH) {
        throw new Error(`organization id must be at most ${MAX_ORG_ID_LENGTH} characters (got ${String(id).length})`);
    }
    const ex = await getOne('SELECT id FROM organizations WHERE id = $1', [id]);
    if (ex) return false;
    try {
        await run(`INSERT INTO organizations (id, name, description, tagline, address, email, phone, website, kvk, vat, logo, "footerText", "defaultGroups", "allowSignup", "authMethod", "autoApproveSSO", "enabledIntegrations", "allowed_domains", "nc_instance_id", "nc_base_url", "nc_admin_uid", "nc_provisioned_at", "connector_callback_url", "registration_source")
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)`,
            [id, name, description || '', tagline || '', address || '', email || '', phone || '', website || '', kvk || '', vat || '', logo || '', footerText || '', JSON.stringify(defaultGroups || []), allowSignup ? '1' : '0', authMethod || null, autoApproveSSO ? '1' : '0', enabledIntegrations ? JSON.stringify(enabledIntegrations) : null, allowedDomains ? JSON.stringify(allowedDomains) : null, ncInstanceId || null, ncBaseUrl || null, ncAdminUid || null, ncProvisionedAt || null, connectorCallbackUrl || null, registrationSource || null]);
        // Auto-assign default subscription plan if one exists — cloud only.
        // Self-hosted (incl. the retired 'private-cloud' value) never seeds a
        // Stripe subscription row; tier is server-licence or Community, resolved
        // without ever consulting subscriptions.
        try {
            const subscriptionsEnabled = (process.env.DEPLOYMENT_MODE || 'cloud') === 'cloud';
            // BFSF-226: resolve the default org plan via the shared helper, which
            // falls back to the cheapest org plan if the is_default invariant was
            // lost. This guarantees a new cloud org never lands with no
            // subscription row (→ getEffectiveLimits null → unlimited access).
            const defaultPlanId = subscriptionsEnabled ? await getDefaultOrgPlanId() : null;
            if (defaultPlanId) {
                const assigned = await setOrgSubscription(id, { plan_id: defaultPlanId, status: 'active' });
                if (assigned) {
                    log.info(`[UserStore] Auto-assigned default plan '${defaultPlanId}' to new org '${id}'`);
                    // Seed integrations + beta-feature enablement from the plan
                    // so new orgs immediately have the right defaults switched on.
                    try {
                        await require('../../services/planEntitlements').applyPlanToOrg(id, defaultPlanId, { mode: 'reset' });
                    } catch (e) { log.warn('[UserStore] applyPlanToOrg (default plan) failed:', e.message); }
                } else {
                    // setOrgSubscription returns false (not throws) on DB error, so
                    // the surrounding try/catch won't fire. Surface it loudly: the
                    // org has no subscription row and is uncapped until a plan is
                    // assigned (the exact BFSF-226 failure we're guarding against).
                    log.error(`[UserStore] FAILED to assign default plan '${defaultPlanId}' to new org '${id}' — org has NO subscription row and is uncapped. Assign a plan via Admin → Subscriptions → Organizations.`);
                }
            } else if (subscriptionsEnabled) {
                log.warn(`[UserStore] No subscription plans exist — new org '${id}' created WITHOUT a plan (unlimited until one is assigned). Run server/seed-plans.js or the default-org-plan migration.`);
            }
        } catch (e) { log.warn('[UserStore] Failed to auto-assign default plan:', e.message); }
        // Encryption tier for the new org. AWAITED, and placed here on purpose:
        // entitlement is resolved from the org's plan, so it has to run after the
        // plan assignment above, and before the caller attaches the founding user
        // — any write that beats it is written in plaintext. It narrows to 'none'
        // on every failure and never throws, so org creation cannot fail on it.
        try {
            await require('../initialTier').applyDefaultEncryptionTier(id);
        } catch (e) {
            // applyDefaultEncryptionTier does not throw; this is the backstop for
            // the require itself. The org stays on 'none', which is where it was.
            log.error('[UserStore] initial encryption tier could not be applied:', e.message);
        }
        // Fire-and-forget: if a global trial-offer plan is configured for orgs,
        // start the trial in Stripe asynchronously. Failure must not block org
        // creation; trialService swallows errors and logs warnings.
        if (autoGrantTrial) {
            setImmediate(() => {
                require('../../services/trialService').maybeAutoGrantOrgTrial(id);
            });
        }
        // Pre-generate the outbound webhook signing key so the very first
        // outbound webhook for this org carries a valid signature. Lazy
        // generation in webhookSigner.js remains as a safety net, but should
        // not be the primary path. Failures here are logged and ignored —
        // the lazy generator will fill in.
        setImmediate(async () => {
            try {
                const configStore = require('../configStore');
                const key = `org_webhook_signing_key_${id}`;
                const existing = await configStore.getSecret(key).catch(() => null);
                if (existing && typeof existing === 'string' && existing.length >= 32) return;
                const crypto = require('crypto');
                const fresh = crypto.randomBytes(32).toString('hex');
                await configStore.setSecret(key, fresh, { orgId: id, integration: 'webhook_signer' }).catch(() => {});
            } catch (e) {
                log.warn('[UserStore] failed to pre-generate webhook signing key:', e.message);
            }
        });
        return true;
    } catch (e) { log.error(e); return false; }
}

async function updateOrganization(orgId, updates) {
    await initDB();
    const ex = await getOne('SELECT id FROM organizations WHERE id = $1', [orgId]);
    if (!ex) return false;
    const colMap = { name: 'name', description: 'description', tagline: 'tagline', address: 'address', billingLine2: 'billing_line2', billingPostalCode: 'billing_postal_code', billingCity: 'billing_city', billingCountry: 'billing_country', email: 'email', phone: 'phone', website: 'website', kvk: 'kvk', vat: 'vat', logo: 'logo', footerText: 'footerText', authMethod: 'authMethod', connectorCallbackUrl: 'connector_callback_url', ncSyncMode: 'nc_sync_mode', ncNewUserDefaultStatus: 'nc_new_user_default_status', ncLastSyncAt: 'nc_last_sync_at', ncInstanceId: 'nc_instance_id', ncBaseUrl: 'nc_base_url', ncAdminUid: 'nc_admin_uid', ncProvisionedAt: 'nc_provisioned_at', ncOnboardingCompletedAt: 'nc_onboarding_completed_at', deploymentMode: 'deployment_mode', selectedPlanId: 'selected_plan_id', status: 'status', encryptionTier: 'encryption_tier', encryptionScope: 'encryption_scope' };
    const updateMap = {};
    for (const k of Object.keys(colMap)) { if (updates[k] !== undefined) updateMap[k] = updates[k]; }
    if (updates.defaultGroups !== undefined) updateMap.defaultGroups = JSON.stringify(updates.defaultGroups);
    if (updates.allowSignup !== undefined) updateMap.allowSignup = updates.allowSignup ? '1' : '0';
    if (updates.autoApproveSSO !== undefined) updateMap.autoApproveSSO = updates.autoApproveSSO ? '1' : '0';
    if (updates.usagePooled !== undefined) updateMap.usage_pooled = updates.usagePooled ? '1' : '0';
    if (updates.enabledIntegrations !== undefined) updateMap.enabledIntegrations = updates.enabledIntegrations === null ? null : JSON.stringify(updates.enabledIntegrations);
    if (updates.allowedDomains !== undefined) updateMap.allowed_domains = updates.allowedDomains === null ? null : JSON.stringify(updates.allowedDomains);
    if (updates.ncSyncGroups !== undefined) updateMap.nc_sync_groups = JSON.stringify(updates.ncSyncGroups);
    if (updates.ncSyncExcludedGroups !== undefined) updateMap.nc_sync_excluded_groups = JSON.stringify(updates.ncSyncExcludedGroups);
    const fullColMap = { ...colMap, defaultGroups: 'defaultGroups', allowSignup: 'allowSignup', autoApproveSSO: 'autoApproveSSO', usage_pooled: 'usage_pooled', enabledIntegrations: 'enabledIntegrations', allowed_domains: 'allowed_domains', nc_sync_groups: 'nc_sync_groups', nc_sync_excluded_groups: 'nc_sync_excluded_groups' };
    try {
        const q = dynamicUpdate('organizations', orgId, updateMap, fullColMap);
        if (q) await run(q.sql, q.params);
        return true;
    } catch (e) { log.error(e); return false; }
}

// ── Org-admin "active" subsets ────────────────────────────────────
// These are the per-org enablement lists the ORG admin controls (as
// opposed to enabledIntegrations / beta_features which the SUPER admin
// controls). Runtime gates intersect with the super-admin lists, so a
// stale entry here cannot grant access to something the super admin
// hasn't allowed.

async function getOrgEnabledIntegrations(orgId) {
    await initDB();
    const o = await getOne('SELECT "org_enabled_integrations" FROM organizations WHERE id = $1', [orgId]);
    return parseJSON(o?.org_enabled_integrations, []);
}

async function setOrgEnabledIntegrations(orgId, ids) {
    await initDB();
    const clean = Array.isArray(ids) ? Array.from(new Set(ids.filter(Boolean))) : [];
    const { rowCount } = await run(
        'UPDATE organizations SET "org_enabled_integrations" = $1 WHERE id = $2',
        [JSON.stringify(clean), orgId]
    );
    return rowCount > 0;
}

async function getOrgEnabledBetaFeatures(orgId) {
    await initDB();
    const o = await getOne('SELECT "org_enabled_beta_features" FROM organizations WHERE id = $1', [orgId]);
    return parseJSON(o?.org_enabled_beta_features, []);
}

async function setOrgEnabledBetaFeatures(orgId, ids) {
    await initDB();
    const clean = Array.isArray(ids) ? Array.from(new Set(ids.filter(Boolean))) : [];
    const { rowCount } = await run(
        'UPDATE organizations SET "org_enabled_beta_features" = $1 WHERE id = $2',
        [JSON.stringify(clean), orgId]
    );
    return rowCount > 0;
}

// Org-wide ("All members") grants for the CORE + MCP capability kinds. The
// integration/beta everyone-grants live in the org_enabled_* columns above;
// this column carries the rest so the Access & Permissions matrix has one
// place to write core/mcp everyone-grants.
async function getOrgGrantedCapabilities(orgId) {
    await initDB();
    const o = await getOne('SELECT "org_granted_capabilities" FROM organizations WHERE id = $1', [orgId]);
    return parseJSON(o?.org_granted_capabilities, []);
}

async function setOrgGrantedCapabilities(orgId, ids) {
    await initDB();
    const clean = Array.isArray(ids) ? Array.from(new Set(ids.filter(Boolean))) : [];
    const { rowCount } = await run(
        'UPDATE organizations SET "org_granted_capabilities" = $1 WHERE id = $2',
        [JSON.stringify(clean), orgId]
    );
    return rowCount > 0;
}

// Per-org ACCESS MENU (super-admin controlled): which matrix capabilities the
// org may use, within the plan/license ceiling. Returns null when unrestricted
// (the org may use everything its ceiling allows). Setting null clears the
// restriction; setting an array narrows it.
async function getOrgAvailableCapabilities(orgId) {
    await initDB();
    const o = await getOne('SELECT "org_available_capabilities" FROM organizations WHERE id = $1', [orgId]);
    if (!o || o.org_available_capabilities == null) return null;
    return parseJSON(o.org_available_capabilities, null);
}

async function setOrgAvailableCapabilities(orgId, ids) {
    await initDB();
    const value = ids == null ? null : JSON.stringify(Array.from(new Set((Array.isArray(ids) ? ids : []).filter(Boolean))));
    const { rowCount } = await run(
        'UPDATE organizations SET "org_available_capabilities" = $1 WHERE id = $2',
        [value, orgId]
    );
    return rowCount > 0;
}

// Which GROUP-SCOPED betas (betaFeatures.js `groupScoped`) the org grants to
// ALL members. Returns null when the org never chose: every group-scoped beta
// is then on for everyone, the behaviour from before the list existed. An
// array (possibly empty) is an explicit choice; the rest go to groups only.
async function getOrgBetaEveryone(orgId) {
    await initDB();
    const o = await getOne('SELECT "org_beta_everyone" FROM organizations WHERE id = $1', [orgId]);
    if (!o || o.org_beta_everyone == null) return null;
    const list = parseJSON(o.org_beta_everyone, null);
    return Array.isArray(list) ? list : null;
}

async function setOrgBetaEveryone(orgId, ids) {
    await initDB();
    const value = ids == null ? null : JSON.stringify(Array.from(new Set((Array.isArray(ids) ? ids : []).filter(Boolean))));
    const { rowCount } = await run(
        'UPDATE organizations SET "org_beta_everyone" = $1 WHERE id = $2',
        [value, orgId]
    );
    return rowCount > 0;
}

// SELF-HOSTED: the matrix-togglable core / non-group-scoped beta ids the org
// admin switched OFF for "All members". Returns null when never chosen (nothing
// revoked, the single-switch behaviour from before the column existed).
async function getOrgEveryoneRevoked(orgId) {
    await initDB();
    const o = await getOne('SELECT "org_everyone_revoked" FROM organizations WHERE id = $1', [orgId]);
    if (!o || o.org_everyone_revoked == null) return null;
    const list = parseJSON(o.org_everyone_revoked, null);
    return Array.isArray(list) ? list : null;
}

async function setOrgEveryoneRevoked(orgId, ids) {
    await initDB();
    const value = ids == null ? null : JSON.stringify(Array.from(new Set((Array.isArray(ids) ? ids : []).filter(Boolean))));
    const { rowCount } = await run(
        'UPDATE organizations SET "org_everyone_revoked" = $1 WHERE id = $2',
        [value, orgId]
    );
    return rowCount > 0;
}

/**
 * The per-org config rows whose key does NOT follow the `org_<orgId>_*`
 * convention, and which the LIKE wipe in deleteOrganization therefore misses.
 *
 * Built from the feature modules' own exported CONFIG_KEY_PREFIX constants
 * rather than from copies of the strings, and pinned by
 * organizations.configKeys.test.js: a new per-org prefix anywhere in the tree
 * fails that test until somebody decides whether it dies with the org.
 *
 * This is a class of bug, not two instances. `org_integration_cache_<id>` and
 * `org_ai_context_<id>` both slipped past `org_<id>_%`, so an organisation's
 * "yes, store third-party response payloads at rest" decision OUTLIVED the
 * organisation — and an org re-created with the same id came back with the
 * feature ON, with nobody having decided that.
 */
function orgConfigKeys(orgId) {
    const { CONFIG_KEY_PREFIX: INTEGRATION_CACHE } = require('../../core/automationRunner/integrationCachePolicy');
    const { CONFIG_KEY_PREFIX: AI_CONTEXT } = require('../../core/llm/contextPolicy');
    const { CONFIG_KEY_PREFIX: ROLE_PERMISSIONS } = require('../../auth/orgRolePolicy');
    return [
        `${INTEGRATION_CACHE}${orgId}`,
        `${AI_CONTEXT}${orgId}`,
        // An org's "our Members may not open Notebooks" decision must not
        // outlive the org and greet a re-created one with the same id.
        `${ROLE_PERMISSIONS}${orgId}`,
        // Legacy suffix pattern — keep deleting by exact key for one release
        // window so older deploys clean up.
        `org_privacy_shield_${orgId}`,
        // Without this a stale connector cache keeps presenting JWTs signed by
        // the deleted org's key.
        `connector_tenant_key_${orgId}`,
        // De twee U10-vlaggen: allebei een keuze die iemand voor DEZE
        // organisatie maakte, dus allebei sterven ze met haar. Blijven ze
        // staan, dan komt een org die op hetzelfde id wordt heropgericht
        // terug met een MFA-plicht of een schild dat niemand koos.
        `${require('../../core/entitlements/orgMfaRequired').CONFIG_KEY_PREFIX}${orgId}`,
        `${require('../../core/entitlements/coworkShieldFlag').CONFIG_KEY_PREFIX}${orgId}`,
        // De huisstijl voor documenten: het logo en de bedrijfsgegevens van
        // DEZE organisatie. Blijft hij staan, dan komt een org die op hetzelfde
        // id wordt heropgericht terug met andermans briefhoofd — en met een
        // logo dat als data: URL in de config staat, dus echte bytes van een
        // verwijderde organisatie.
        `${require('../../core/documents/documentHouseStyle').CONFIG_KEY_PREFIX}${orgId}`,
        // De leerplicht: welke handelingen DEZE organisatie achter een cursus
        // zet en welke cursus ze weer vrijgeeft. Ook dat is een keuze die
        // iemand hier maakte, dus hij sterft met de organisatie — blijft hij
        // staan, dan komt een org die op hetzelfde id wordt heropgericht
        // terug met een cursusplicht die niemand daar instelde.
        `${require('../../learning/trainingGates').CONFIG_KEY_PREFIX}${orgId}`,
        // Whether members may edit project notebooks and pages together, and
        // how the AI may join conversations by itself: both chosen for THIS
        // organisation, so both die with it.
        `${require('../collabDocStore').COLLAB_SETTINGS_KEY_PREFIX}${orgId}`,
        `${require('../../projects/participation/policy').CONFIG_KEY_PREFIX}${orgId}`,
    ];
}

async function deleteOrganization(orgId) {
    await initDB();
    const org = await getOne('SELECT id, nc_instance_id FROM organizations WHERE id = $1', [orgId]);
    if (!org) return false;
    log.info(`[UserStore] Deleting organization '${orgId}' and all related data...`);

    // Every step throws on failure, so the organizations row at the end is only
    // reached once nothing of the tenant's data can outlive it.
    let step = 'users';
    try {
        const orgUsers = await getAll('SELECT id FROM users WHERE "organizationId" = $1', [orgId]);
        // All of them first: deleteUser refuses an account that runs a Solution
        // stage, and the org must not be left half-deleted when the last one does.
        for (const u of orgUsers) await assertNotStageRunAs(u.id);
        for (const u of orgUsers) await deleteUser(u.id);
        if (orgUsers.length > 0) log.info(`[UserStore] Deleted ${orgUsers.length} user(s) from org '${orgId}'`);

        step = 'groups';
        await run('DELETE FROM groups WHERE "organizationId" = $1', [orgId]);
        step = 'organization_subscriptions';
        await run('DELETE FROM organization_subscriptions WHERE organization_id = $1', [orgId]);

        // Biometric and credential rows whose user was removed by another path
        // must not outlive the org that consented to them. Grants go first so
        // the FK cascade has nothing left to do.
        step = 'voiceprints';
        await run('DELETE FROM voiceprints WHERE organization_id = $1', [orgId]);
        step = 'connection_grants';
        await run('DELETE FROM connection_grants WHERE org_id = $1', [orgId]);
        step = 'integration_connections';
        await run('DELETE FROM integration_connections WHERE org_id = $1', [orgId]);
        step = 'automation_credentials';
        await run('DELETE FROM automation_credentials WHERE org_id = $1', [orgId]);
        step = 'mcp_tokens';
        await run('DELETE FROM mcp_tokens WHERE org_id = $1', [orgId]);

        // Through the store, so the memoised per-org usage counters go with the rows.
        step = 'integration cache';
        const purged = await require('../integrationCacheStore').purgeForOrg(orgId);
        if (purged > 0) log.info(`[UserStore] Purged ${purged} cached integration answer(s) for org '${orgId}'`);

        // The `org_<orgId>_*` family by pattern; the keys that do not follow that
        // convention (ORG_CONFIG_KEYS) by name, through configStore so every
        // replica's cache is invalidated with them.
        step = 'config';
        const { rowCount: cfgDeleted } = await run('DELETE FROM config WHERE key LIKE $1', [`org_${orgId}_%`]);
        if (cfgDeleted > 0) log.info(`[UserStore] Deleted ${cfgDeleted} per-org config row(s) for '${orgId}'`);
        const configStore = require('../configStore');
        for (const key of orgConfigKeys(orgId)) await configStore.deleteConfig(key);

        step = 'agents';
        const orgAgents = await getAll('SELECT id FROM agents WHERE organization_id = $1', [orgId]);
        for (const agent of orgAgents) await run('DELETE FROM agent_conversations WHERE agent_id = $1', [agent.id]);
        await run('DELETE FROM agents WHERE organization_id = $1', [orgId]);

        step = 'knowledge_bases';
        await run('DELETE FROM knowledge_bases WHERE organization_id = $1', [orgId]);
        // Projects cascade shares and activity via FK; group shares went with the
        // groups above, user shares with the users.
        step = 'projects';
        await run('DELETE FROM projects WHERE organization_id = $1', [orgId]);
        step = 'group_chats';
        await run('DELETE FROM group_chats WHERE organization_id = $1', [orgId]);
        step = 'tasks';
        await run('DELETE FROM tasks WHERE organization_id = $1', [orgId]);

        // Datatables: rows first, metadata second. The rows live in a schema of
        // their own that no foreign key reaches, so this is the only code that
        // deletes them. A crash after the drop leaves visible, repairable
        // metadata; the inverse order leaves personal data nothing describes.
        // The store resolves the schema name from its scope; it is never
        // concatenated here, because the drop is irreversible.
        step = 'datatable rows';
        const datatableDbStore = require('../datatableDbStore');
        const scopeKey = datatableDbStore.orgScopeKey(orgId);
        const hasModel = await getOne(
            `SELECT 1 AS present FROM datatable_models WHERE scope_kind = 'org' AND scope_id = $1`, [orgId]);
        if (hasModel) {
            await datatableDbStore.reset(scopeKey, scopeKey);
            log.info(`[UserStore] Dropped the datatable schema for org '${orgId}'`);
        }
        step = 'datatable metadata';
        // usage and grants cascade from `datatables`; said explicitly because a
        // cascade dropped by a migration would otherwise fail silently here.
        await run('DELETE FROM automation_datatable_usage WHERE organization_id = $1', [orgId]);
        await run(`DELETE FROM datatable_grants WHERE datatable_id IN
                   (SELECT id FROM datatables WHERE organization_id = $1)`, [orgId]);
        await run('DELETE FROM datatables WHERE organization_id = $1', [orgId]);
        // By scope: a personal model has no organisation, so `organization_id`
        // would leave this org's own model row behind on a NULL comparison.
        await run(`DELETE FROM datatable_models WHERE scope_kind = 'org' AND scope_id = $1`, [orgId]);
        // The store memoises "this org has datatables" for 60s; a re-created
        // org id must not inherit that answer.
        datatableDbStore.invalidate(scopeKey);

        step = 'custom_tables';
        const customTables = await getAll('SELECT table_name FROM custom_tables WHERE organization_id = $1', [orgId]);
        for (const ct of customTables) {
            const safeName = ct.table_name.replace(/[^a-zA-Z0-9_]/g, '');
            await run(`DROP TABLE IF EXISTS "${safeName}"`);
        }
        await run('DELETE FROM custom_tables WHERE organization_id = $1', [orgId]);

        step = 'dashboards';
        const dashboards = await getAll('SELECT id FROM dashboards WHERE organization_id = $1', [orgId]);
        if (dashboards.length > 0) {
            await run('DELETE FROM dashboard_panels WHERE dashboard_id = ANY($1)', [dashboards.map(d => d.id)]);
        }
        await run('DELETE FROM dashboards WHERE organization_id = $1', [orgId]);

        step = 'organizations';
        await run('DELETE FROM organizations WHERE id = $1', [orgId]);
    } catch (e) {
        log.error(`[UserStore] Deleting organization '${orgId}' failed at ${step}: ${e.message}`);
        throw e;
    }
    log.info(`[UserStore] Organization '${orgId}' deleted successfully`);
    return true;
}

// One-shot idempotent backfill: rename connector-provisioned organisations that
// are still on the generic default name "Nextcloud" to a self-describing
// "Nextcloud (<host>)" so they're distinguishable in the admin list. Safe —
// org id is the stable key, name is display-only. After a row is renamed it no
// longer matches the predicate, so subsequent boots are no-ops.
async function backfillAutoProvisionedNcOrgNames() {
    await initDB();
    try {
        const { buildAutoOrgName } = require('../../auth/orgNaming');
        const orgs = await getAllOrganizations();
        let updated = 0;
        for (const org of orgs) {
            if (org.authMethod !== 'nextcloud_connector') continue;
            if (org.name !== 'Nextcloud') continue;
            if (!org.nc_base_url) continue;
            const newName = buildAutoOrgName(org.name, org.nc_base_url);
            if (newName === org.name) continue;
            if (await updateOrganization(org.id, { name: newName })) updated++;
        }
        if (updated > 0) log.info(`[UserStore] Backfilled ${updated} auto-provisioned NC org name(s)`);
    } catch (e) {
        log.warn('[UserStore] backfillAutoProvisionedNcOrgNames failed:', e.message);
    }
}

module.exports = {
    getAllOrganizations, getSingleOrgId, hasAnyOrganization, getOrganization, getOrganizationByNcInstanceId,
    createOrganization, updateOrganization, deleteOrganization,
    findUnboundOrgByEmailDomain,
    getOrgEnabledIntegrations, setOrgEnabledIntegrations, getOrgEnabledBetaFeatures, setOrgEnabledBetaFeatures,
    getOrgGrantedCapabilities, setOrgGrantedCapabilities,
    getOrgAvailableCapabilities, setOrgAvailableCapabilities,
    getOrgBetaEveryone, setOrgBetaEveryone,
    getOrgEveryoneRevoked, setOrgEveryoneRevoked,
    backfillAutoProvisionedNcOrgNames,
    orgConfigKeys,
    MAX_ORG_ID_LENGTH,
};
