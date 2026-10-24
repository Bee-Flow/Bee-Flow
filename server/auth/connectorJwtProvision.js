// @typecheck
/**
 * Provisioning phase of the Nextcloud Connector JWT middleware: a verified
 * token whose email has no Bee Flow user yet (see connectorJwt.js for the
 * overall flow and connectorJwtPhases.js for the outcome contract: reject /
 * fail / ok, never touching `res` or `next`).
 */

const userStore = require('../stores/userStore');
const orgRolesConfig = require('../config/orgRoles.json');
const { checkConnectorSignupAllowed } = require('./signupGuards');
// Org-health capture is fire-and-forget (never awaited, never throws).
// (via connector/serviceDeps: the single auth -> services edge, see layering.test.js)
const { orgHealth } = require('./connector/serviceDeps');
const log = require('../telemetry/log');
const { bestEffort } = require('../utils/bestEffort');
const { HttpError } = require('../shared/httpErrors');
const {
    reject, fail, ok, _isOrgAdminRequester, _resolveRequesterNcUid,
} = require('./connectorJwtPhases');

// Default org-role for NC users auto-provisioned through the connector.
// `agent_editor` gives them what they expect coming from the embedded SPA:
// view + author agents/skills/knowledge, use notebooks — but no
// org-administration powers. An org-admin can override the default via
// org.nc_new_user_default_org_role and promote individual users later.
const VALID_ORG_ROLES = new Set(Object.keys(orgRolesConfig));
// nosemgrep: ajinabraham.njsscan.generic.hardcoded_secrets.node_username -- a default org role name, not a username or a credential
const DEFAULT_NC_USER_ORG_ROLE = 'agent_editor';

function resolveDefaultNcUserOrgRole(org) {
    const requested = String(org?.nc_new_user_default_org_role || '').trim();
    if (requested && VALID_ORG_ROLES.has(requested)) return requested;
    return DEFAULT_NC_USER_ORG_ROLE;
}


/**
 * Fire-and-forget: tell the org's admins a Nextcloud user was auto-created
 * as `pending` and is waiting for approval (Fase 1.2 — without this the
 * pending pileup is invisible until someone opens the users panel). Metadata
 * only: display name / email of the new user, never message content. Also
 * writes the access-audit seed row for the pending-approval story. Never
 * throws; callers invoke via setImmediate so the 403 response is never
 * delayed.
 */
async function _notifyOrgAdminsOfPendingUser(orgId, newUser) {
    try {
        const notificationStore = require('../stores/notificationStore');
        const { getAll } = require('../db');
        // 'org_admin' is canonical; legacy 'admin' orgRole kept for orgs that
        // pre-date the rename (same predicate as compliance/events.js).
        const admins = await getAll(
            `SELECT id FROM users WHERE "organizationId" = $1 AND "orgRole" IN ('org_admin', 'admin') LIMIT 20`,
            [orgId],
        );
        const who = newUser?.displayName || newUser?.email || newUser?.id || 'A new user';
        for (const a of admins || []) {
            await notificationStore.createNotification({
                userId: a.id,
                category: 'heads_up',
                title: 'New user awaiting approval',
                message: `${who}${newUser?.email ? ` (${newUser.email})` : ''} was created from Nextcloud and needs approval before they can use Bee Flow AI.`,
                link: require('../utils/appPaths').adminSecurityUsersPath(),
            }).catch((err) => bestEffort('connectorJwtProvision:notify-admin', err));
        }
    } catch (e) {
        log.warn(`[ConnectorJWT] pending-user admin notification failed for org ${orgId}: ${e.message}`);
    }
}

/**
 * Admin carve-out (see the comment below). Returns the re-ensured org-admin
 * user, or null when the requester is not an NC admin / the ensure failed or
 * produced nothing. Never throws for an ensure failure (warned, swallowed).
 */
async function _adminCarveOut(org, orgId, payload, reqNcUid) {
    let user = null;
    // Admin carve-out — ANY Nextcloud admin must always be able to reach
    // the onboarding wizard and act, even before onboarding completes and
    // even if their Bee Flow user row was lost (e.g. an org delete/recreate
    // race) or their NC email changed since bootstrap. Without this they
    // fall into the NC_ONBOARDING_PENDING gate below and can never finish
    // onboarding — a permanent 403 lockout for the whole org.
    //
    // Two signals: (1) the
    // tenant-key-signed `nc_admin` JWT claim, set by the connector from the
    // user's real Nextcloud `admin`-group membership — this is what lets
    // EVERY NC admin onboard, not just the one captured at bootstrap; and
    // (2) an exact match on the org's recorded nc_admin_uid (the bootstrap
    // admin) as a fallback for connectors that predate the claim (matched against the
    // SIGNED `sub`; the unsigned header is only used when `sub` is absent). Either
    // way we re-establish their org_admin row idempotently and continue.
    if (payload.nc_admin === true || _isOrgAdminRequester(org, reqNcUid)) {
        try {
            const { ensureOrgAdminUser } = require('./connectorBootstrap').helpers;
            const adminUser = await ensureOrgAdminUser(org, {
                ncAdminEmail: payload.email,
                ncAdminUid: reqNcUid,
                ncAdminDisplayName: payload.name || reqNcUid,
            });
            if (adminUser) {
                user = adminUser;
                log.info(`[ConnectorJWT] Re-ensured org-admin ${adminUser.id} for org ${orgId} (onboarding-gate bypass)`);
            }
        } catch (e) {
            log.warn(`[ConnectorJWT] ensureOrgAdminUser failed for org ${orgId}: ${e.message}`);
        }
    }
    return user;
}

/**
 * Gates for auto-provisioning a NEW user: onboarding wizard pending, manual
 * sync mode, geo policy. Returns a reject outcome, or null to continue.
 */
async function _provisioningGate(req, org, orgId, payload) {
    // Hold auto-provision until the org-admin has finished the App
    // Store onboarding wizard. Otherwise users would land here with
    // pre-wizard defaults (mirror_all + active) which the admin may
    // be about to switch to pending-approval / selective_groups.
    // The SPA-side render gate translates this 403 into a friendly
    // "Setup in progress" screen.
    if (org.nc_instance_id && !org.nc_onboarding_completed_at) {
        orgHealth.problem('auth.blocked_onboarding_pending', {
            orgId, source: 'connectorJwt', req,
            meta: { reason: 'nc_onboarding_not_completed' },
        });
        return reject(403, {
            error: 'Setup in progress — your organization administrator is finalising the Bee Flow setup. Please refresh in a few minutes.',
            code: 'NC_ONBOARDING_PENDING',
        });
    }
    const mode = org.nc_sync_mode || 'mirror_all';
    if (mode === 'manual') {
        orgHealth.problem('auth.blocked_manual_mode', {
            orgId, source: 'connectorJwt', req,
            meta: { reason: 'nc_sync_mode_manual' },
        });
        return reject(403, {
            error: 'Your Nextcloud account is not provisioned in Bee Flow yet. Ask your Bee Flow administrator to invite you.',
        });
    }
    // Geo-blocking for connector signups — evaluated against the
    // connecting Nextcloud server's location (req.ip). Gates only the
    // creation of a NEW user; existing users and the admin carve-out
    // above are never geo-checked. Fail-open and never throws so the
    // connector can't break on a geo hiccup. See signupGuards.js.
    const geoGate = await checkConnectorSignupAllowed(req);
    if (!geoGate.ok) {
        log.info(`[ConnectorJWT] Geo-blocked auto-provision for ${log.textForLog(payload.email)} (org=${orgId}, country=${geoGate.country || 'unknown'})`);
        orgHealth.problem('auth.blocked_geo', {
            orgId, source: 'connectorJwt', req,
            meta: { country: geoGate.country || null, reason: 'geo_policy' },
        });
        return reject(geoGate.status, { error: geoGate.error, code: geoGate.code });
    }
    return null;
}

/**
 * Create the user (seat check included). Returns reject (seat cap / pending
 * approval), fail (HttpError 500 provision_failed) or ok(user).
 */
async function _autoProvision(req, org, orgId, payload, reqNcUid) {
    const ncUid = reqNcUid;
    const status = (org.nc_new_user_default_status === 'pending') ? 'pending' : 'active';
    const userId = `nc_${orgId}_${(ncUid || payload.email).replace(/[^a-zA-Z0-9]+/g, '-').slice(0, 40)}`;
    const defaultOrgRole = resolveDefaultNcUserOrgRole(org);
    const r = await userStore.createUserWithSeatCheck({
        id: userId,
        username: payload.email,
        email: payload.email,
        displayName: payload.name || ncUid || payload.email,
        role: 'user',
        orgRole: defaultOrgRole,
        organizationId: orgId,
        ncUid: ncUid || null,
        provider: 'nextcloud_connector',
        autoProvisioned: true,
        status,
    }, { strict: false });
    if (!r.created) {
        if (r.reason === 'seat_cap') {
            orgHealth.problem('auth.blocked_seat_cap', {
                orgId, source: 'connectorJwt', req,
                meta: { reason: 'seat_cap_exceeded' },
            });
            return reject(403, {
                error: 'Your organization has reached its user seat limit. Ask your Bee Flow administrator to upgrade.',
                code: 'seat_cap_exceeded',
            });
        }
        log.warn(`[ConnectorJWT] auto-provision failed userId=${userId} reason=${r.reason}`);
        orgHealth.problem('auth.provision_failed', {
            orgId, source: 'connectorJwt', req,
            meta: { reason: r.reason || 'unknown' },
        });
        return fail(new HttpError(500, 'provision_failed', 'Failed to provision user'));
    }
    const user = await userStore.getUser(userId);
    log.info(`[ConnectorJWT] Auto-provisioned user ${userId} (org=${orgId}, status=${status})`);
    orgHealth.event('auth.user_auto_provisioned', {
        orgId, source: 'connectorJwt', req, actorKind: 'connector',
        meta: { userId, status },
    });
    if (status === 'pending') {
        orgHealth.problem('auth.blocked_pending_approval', {
            orgId, source: 'connectorJwt', req,
            meta: { lastUserId: userId, reason: 'auto_provisioned_pending' },
        });
        // Fase 1.2 — point the org admins at the approval queue +
        // audit-trail seed. Fire-and-forget: the 403 below must not
        // wait on notification/audit writes.
        const pendingUser = user;
        setImmediate(() => {
            try {
                _notifyOrgAdminsOfPendingUser(orgId, pendingUser).catch((err) => bestEffort('connectorJwtProvision:notify-admins', err));
                userStore.logAccessAudit('nc_user_autoprovisioned_pending', 'user', userId,
                    'system:connector_jwt', null, { orgId, status: 'pending' }, orgId).catch((err) => bestEffort('connectorJwtProvision:audit-pending', err));
            } catch (err) { bestEffort('connectorJwtProvision:pending-followups', err); }
        });
        return reject(403, {
            error: 'Your account has been created in Bee Flow but requires admin approval. Please contact your organization administrator.',
        });
    }
    return ok(user);
}

/**
 * Provision-or-recover the user for a verified token whose email has no
 * Bee Flow user yet. Returns reject / fail, or ok(user). `user` can be null
 * in ok() only if the store lost the row right after creating it; the caller
 * dereferences it inside its try block, which answers 401 (fail closed).
 */
async function provisionConnectorUser(req, orgId, payload) {
    // Auto-provision: org's sync_mode determines whether we silently
    // create the user (active vs pending) or reject. This is the path
    // every NC user takes on their first click of the Bee Flow icon
    // after the org is bootstrapped — see plan/connector docs.
    const org = await userStore.getOrganization(orgId);
    if (!org) {
        return reject(403, { error: 'Connector tenant has no organization' });
    }
    const reqNcUid = _resolveRequesterNcUid(req, payload);
    const adminUser = await _adminCarveOut(org, orgId, payload, reqNcUid);
    if (adminUser) return ok(adminUser);
    const gate = await _provisioningGate(req, org, orgId, payload);
    if (gate) return gate;
    return _autoProvision(req, org, orgId, payload, reqNcUid);
}

module.exports = { provisionConnectorUser };
