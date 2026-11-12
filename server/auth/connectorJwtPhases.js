// @typecheck
/**
 * Phases of the Nextcloud Connector JWT middleware that run AFTER the tenant
 * key has verified the token (see connectorJwt.js for the entry point and the
 * overall flow; connectorJwtProvision.js creates new users): gate on org and
 * approval state, reconcile the user row, and populate the in-memory session.
 *
 * Control-flow contract (fail closed): a phase never touches `res` or `next`.
 * It returns an OUTCOME and the single caller decides what to send:
 *   - reject(status, body)  -> the caller answers res.status(status).json(body)
 *   - fail(err)             -> the caller answers next(err)
 *   - ok(user)              -> the caller continues (or, for the last phase,
 *                              calls next() with no arguments)
 * A gate returns an outcome or null (null = pass). Anything that throws is
 * caught by the caller's try block and answered 401. The caller only proceeds
 * on kind === 'ok'; an unknown kind is treated as a failure, never a pass.
 */

const userStore = require('../stores/userStore');
const encryption = require('./encryption');
const { suppressSessionPersistence } = require('./establishSession');
// Org-health capture is fire-and-forget (never awaited, never throws): this
// code runs on EVERY connector request and must not gain latency or failure
// modes. See connectorJwt.js.
// (via connector/serviceDeps: the single auth -> services edge, see layering.test.js)
const serviceDeps = require('./connector/serviceDeps');
const { orgHealth } = serviceDeps;
const log = require('../telemetry/log');
const { fallback } = require('../utils/bestEffort');
const { isLoginBlockedAccount } = require('./accountStatusGate');
const { emailLinkAllowed } = require('./ssoUserResolver');
const { issueLinkTicket, linkPageUrl } = require('./connector/ncLinkTicket.mts');

/** @typedef {{ kind: 'reject', status: number, body: object }} Reject */
/** @typedef {{ kind: 'error', error: Error }} Fail */
/** @typedef {{ kind: 'ok', user: any }} Ok */

/** @param {number} status @param {{ error: string; code?: string; linkUrl?: string }} body @returns {Reject} */
function reject(status, body) { return { kind: 'reject', status, body }; }
/** @param {Error} error @returns {Fail} */
function fail(error) { return { kind: 'error', error }; }
/** @param {Record<string, unknown> | null} [user] @returns {Ok} */
function ok(user = null) { return { kind: 'ok', user }; }

// True iff the request's Nextcloud uid is THIS org's recorded NC admin. Used to
// let the org admin past the NC_ONBOARDING_PENDING gate so onboarding can never
// deadlock. Match is an exact equality on the stable nc_admin_uid. reqNcUid
// comes from _resolveRequesterNcUid: the tenant-key-signed JWT `sub` wins; the
// unsigned X-Beeflow-NC-Uid header is only a last-resort fallback.
/**
 * @param {string} reqNcUid
 */
function _isOrgAdminRequester(org, reqNcUid) {
    return !!(org && org.nc_admin_uid && reqNcUid && reqNcUid === org.nc_admin_uid);
}

// The signed `sub` claim always wins over the unsigned header.
function _resolveRequesterNcUid(req, payload) {
    return String(payload?.sub || req?.headers?.['x-beeflow-nc-uid'] || '').trim();
}

// The NC identity stored on the session: the user row's own nc_uid, then the
// signed `sub`, and only last the unsigned header.
function _resolveSessionNcUid(user, req, payload) {
    return user?.nc_uid || _resolveRequesterNcUid(req, payload) || null;
}

// Cache derived encryption keys per userId. The fallback key uses PBKDF2 with
// 210k iterations (~50-100ms each) — running that on every request is
// noticeable in chat latency. The derived key is fully determined by
// userId + MASTER_ENCRYPTION_KEY, both stable, so we cache forever (process
// lifetime). Cleared on server restart.
const _encKeyCache = new Map();

/**
 * The JWT was signed with org X's key, so the EXISTING user it names must be
 * a member of org X: the key speaks for that org's Nextcloud and for nobody
 * else. Returns a reject outcome for a user bound to a different org, for a
 * user bound to no org (membership is what the key vouches for; an unbound
 * account is not a member of anything), and for a platform admin (that role
 * is never reached through a tenant's key); null = pass.
 */
function crossTenantGate(req, user, orgId) {
    if (user.organizationId === orgId && user.role !== 'admin') return null;
    const reason = user.role === 'admin' ? 'platform_admin_account'
        : user.organizationId ? 'user_bound_to_other_org'
            : 'user_not_bound_to_org';
    log.warn(`[ConnectorJWT] Cross-tenant rejection: user ${user.id} (org=${user.organizationId || 'none'}) presented org=${orgId}'s key (${reason})`);
    orgHealth.problem('auth.blocked_org_mismatch', {
        orgId, source: 'connectorJwt', req,
        meta: { userOrgId: user.organizationId || null, reason },
    });
    return reject(403, {
        error: reason === 'user_bound_to_other_org'
            ? 'This Nextcloud is connected to a different Bee Flow organisation than your account. Ask an admin of your organisation to generate a pairing code (Admin dashboard → Organisation → Nextcloud Sync → "Pair a new Nextcloud") and re-pair this Nextcloud with it.'
            : 'Your Bee Flow account is not a member of the organisation this Nextcloud is connected to. Sign in to Bee Flow directly, or ask an admin of that organisation to add your account.',
        code: 'NC_ORG_MISMATCH',
    });
}

/** Reject a user whose account still awaits admin approval, or whose status bars it from signing in; null = pass. */
function pendingApprovalGate(req, user, orgId) {
    if (isLoginBlockedAccount(user)) {
        orgHealth.problem('auth.blocked_account', {
            orgId, source: 'connectorJwt', req,
            meta: { lastUserId: user.id, reason: `existing_user_${user.status}` },
        });
        return reject(403, { error: 'Account is not active' });
    }
    if (user.status !== 'pending') return null;
    orgHealth.problem('auth.blocked_pending_approval', {
        orgId, source: 'connectorJwt', req,
        meta: { lastUserId: user.id, reason: 'existing_user_pending' },
    });
    return reject(403, { error: 'Account is pending admin approval' });
}

/**
 * The account a verified token names first: the member of `orgId` that holds
 * the signed uid. Null without a `sub` or when no member holds it; the caller
 * then looks the address up (emailMatchGate decides what that may find).
 * @param {string} orgId
 * @param {ConnectorPayload} payload
 */
async function findByNcUid(orgId, payload) {
    const sub = String(payload?.sub || '').trim();
    return sub ? userStore.getUserByNcUid(orgId, sub) : null;
}

/** Nextcloud uids are unique without regard to case: the same account. */
const sameUid = (/** @type {unknown} */ a, /** @type {unknown} */ b) => !!a && !!b && String(a).toLowerCase() === String(b).toLowerCase();

/** Seam the tests replace: is an SSO identity (Google, Nextcloud OAuth) linked to the account? */
const _linkDeps = {
    /** @param {string} userId */
    hasSsoIdentity: async (userId) => (await require('./ssoIdentityStore.mts').ssoIdentities().listForUser(userId)).length > 0,
};

/**
 * May the connector take this account by its address alone? Only an account
 * the connector or the user sync created, with no credential, second factor,
 * SSO identity or admin role of its own (emailLinkAllowed in
 * ssoUserResolver.js, shared with the SSO sign-in). A failed identity read
 * counts as no.
 * @param {UserRec} user
 */
async function connectorMayTake(user) {
    if (!emailLinkAllowed(user, { provider: 'nextcloud_connector' })) return false;
    try {
        return !(await _linkDeps.hasSsoIdentity(user.id));
    } catch (e) {
        log.warn(`[ConnectorJWT] SSO identity read failed for user ${user.id}: ${/** @type {Error} */ (e).message}`);
        return false;
    }
}

/**
 * The signed uid found no member and the address found `user`, which the
 * connector may not take by its address. Not signed in: the answer says so
 * and carries the page where the account's owner links it once, after a
 * normal sign-in (connector/ncLinkTicket.mts).
 * @param {ConnectorReq} req @param {UserRec} user @param {string} orgId @param {string} sub @param {string} stored
 */
async function linkRequired(req, user, orgId, sub, stored) {
    let linkUrl = '';
    if (sub) {
        const org = await userStore.getOrganization(orgId).catch((err) => fallback('connectorJwtPhases:link-org', err, null));
        let ncHost = '';
        try { ncHost = org?.nc_base_url ? new URL(String(org.nc_base_url)).host : ''; } catch { ncHost = ''; }
        const ticket = issueLinkTicket({ userId: user.id, orgId, ncUid: sub, storedUid: stored, ncHost });
        linkUrl = linkPageUrl(req, ticket);
    }
    log.info(`[ConnectorJWT] Sign-in for org ${orgId} needs a link: the address belongs to user ${user.id}, which the connector does not take by address`);
    return reject(409, {
        error: 'A Bee Flow account with your e-mail address already exists and is not linked to this Nextcloud account yet. Sign in to Bee Flow once to link them.',
        code: 'nc_link_required',
        ...(linkUrl ? { linkUrl } : {}),
    });
}

/**
 * The address found `user` (a member of `orgId`, crossTenantGate passed), and
 * no member holds the signed uid. Returns `{ reject }`, or `{ write }`: what
 * reconcileUserRecord may write on the row (null = nothing, 'fill' = the
 * missing uid, 'repair' = replace the stored uid).
 *
 *   - The stored uid is the signed one in another case: the same account.
 *   - An account the connector may not take by address (connectorMayTake):
 *     nc_link_required.
 *   - No stored uid: filled in from the signed one.
 *   - Another stored uid: Nextcloud is asked about it, as the stored admin.
 *     A live account with this address is another account (409
 *     nc_uid_conflict, the stored uid stays); a definite other answer (gone,
 *     disabled, another address) lets the stored uid be replaced; no answer
 *     refuses the sign-in (503 nc_uid_unverified) and writes nothing.
 * @param {ConnectorReq} req @param {UserRec} user @param {string} orgId @param {ConnectorPayload} payload
 * @returns {Promise<{ reject: Reject } | { write: null | 'fill' | 'repair' }>}
 */
async function emailMatchGate(req, user, orgId, payload) {
    const sub = String(payload.sub || '').trim();
    const stored = user.nc_uid ? String(user.nc_uid) : '';
    if (stored && sameUid(stored, sub)) return { write: null };
    if (!(await connectorMayTake(user))) return { reject: await linkRequired(req, user, orgId, sub, stored) };
    if (!sub) return { write: null };
    if (!stored) return { write: 'fill' };
    let state = 'unknown';
    try {
        const org = await userStore.getOrganization(orgId);
        if (org && org.id === orgId) state = await serviceDeps.storedUidState(org, stored, String(payload.email || ''));
    } catch (e) {
        log.warn(`[ConnectorJWT] Stored nc_uid check failed for user ${user.id}: ${/** @type {Error} */ (e).message}`);
    }
    if (state === 'free') return { write: 'repair' };
    if (state === 'live') {
        log.warn(`[ConnectorJWT] Sign-in refused for org ${orgId}: the e-mail address of user ${user.id} belongs to two live Nextcloud accounts`);
        orgHealth.problem('auth.blocked_nc_uid_conflict', {
            orgId, source: 'connectorJwt', req,
            meta: { lastUserId: user.id, sub, reason: 'stored_uid_live_with_same_email' },
        });
        return { reject: reject(409, {
            error: 'Your e-mail address is already linked to another Nextcloud account in Bee Flow. Ask your Nextcloud administrator to give each account its own e-mail address.',
            code: 'nc_uid_conflict',
        }) };
    }
    log.warn(`[ConnectorJWT] Sign-in refused for org ${orgId}: the Nextcloud uid stored on user ${user.id} could not be checked`);
    return { reject: reject(503, {
        error: 'Bee Flow could not check your Nextcloud account just now. Try again in a few minutes; if this message stays, ask your Bee Flow administrator.',
        code: 'nc_uid_unverified',
    }) };
}

/**
 * Keep the DB row and the session coherent: log data anomalies, and write
 * the signed uid where emailMatchGate allowed it (`write`). Each step
 * swallows its own failure. The user reaching here is a member of `orgId`
 * (crossTenantGate), or was just provisioned into it, so the org pointer
 * needs no reconciling.
 * @param {UserRec} user @param {string} orgId @param {ConnectorPayload} payload
 * @param {null | 'fill' | 'repair'} [write]
 */
async function reconcileUserRecord(user, orgId, payload, write = null) {
    // Observability: surface data-corruption — a user marked as connector-
    // sourced should always live under an NC-bound org. Pure log; only
    // resolves the org for connector-sourced users so non-NC traffic
    // doesn't pay an extra DB roundtrip.
    if (user.provider === 'nextcloud_connector') {
        const orgForCheck = await userStore.getOrganization(user.organizationId || orgId).catch((err) => fallback('connectorJwtPhases:org-anomaly-check', err, null));
        if (orgForCheck && !orgForCheck.nc_instance_id) {
            log.warn(`[ConnectorJWT] Data anomaly: user ${user.id} has provider=nextcloud_connector but org ${orgForCheck.id} has no nc_instance_id`);
        }
    }
    if (write === 'repair') await repairNcUid(user, payload);
    else if (write === 'fill') await fillMissingNcUid(user, orgId, payload);
}

/**
 * Replace a stored nc_uid that Nextcloud says is no longer this address's
 * live account (emailMatchGate). A failure is warned and swallowed.
 * @param {UserRec} user @param {ConnectorPayload} payload
 */
async function repairNcUid(user, payload) {
    if (!user.nc_uid || !payload.sub || user.nc_uid === payload.sub) return;
    try {
        await userStore.updateUser(user.id, { ncUid: payload.sub });
        log.warn(`[ConnectorJWT] Repaired stale nc_uid for user ${user.id}: ${user.nc_uid} → ${payload.sub}`);
        user.nc_uid = payload.sub;
    } catch (e) {
        log.warn(`[ConnectorJWT] Failed to repair nc_uid for ${user.id}: ${/** @type {Error} */ (e).message}`);
    }
}

/**
 * Bind a member with NO stored nc_uid, which the connector may take by its
 * address (emailMatchGate), to the signed `sub`, so automation runs (built
 * from the row) keep their Nextcloud binding. No other row in the org may
 * already hold the uid. A failure is warned and swallowed: the session still
 * carries the uid.
 * @param {UserRec} user @param {string} orgId @param {ConnectorPayload} payload
 */
async function fillMissingNcUid(user, orgId, payload) {
    if (user.nc_uid || !payload.sub || user.organizationId !== orgId) return;
    try {
        const holder = await userStore.getUserByNcUid(orgId, payload.sub);
        if (holder && holder.id !== user.id) {
            log.warn(`[ConnectorJWT] Not binding nc_uid ${payload.sub} to user ${user.id}: user ${holder.id} in org ${orgId} already holds it`);
            return;
        }
        await userStore.updateUser(user.id, { ncUid: payload.sub });
        log.info(`[ConnectorJWT] Bound nc_uid ${payload.sub} to user ${user.id}`);
        user.nc_uid = payload.sub;
    } catch (e) {
        log.warn(`[ConnectorJWT] Failed to bind nc_uid for ${user.id}: ${/** @type {Error} */ (e).message}`);
    }
}

/**
 * Populate the in-memory session (see the long comment on the Object.assign
 * below) and record liveness. Returns ok(user); the CALLER then calls next()
 * exactly once with no arguments.
 */
async function establishConnectorSession(req, user, orgId, payload) {
    const ncUid = _resolveSessionNcUid(user, req, payload);
    const sessionUser = {
        id: user.id,
        email: user.email,
        displayName: user.displayName || user.id,
        role: user.role || 'user',
        orgRole: user.orgRole || '',
        organizationId: user.organizationId || orgId,
        ncUid,
        provider: user.provider || 'nextcloud_connector',
    };
    req.connectorAuth = { orgId, ncUid };

    // Inject encryptionKey for endpoints that read encrypted user state
    // (chat history, agent conversations). The connector path acts like
    // an SSO provider — we trust the upstream Nextcloud session, so we
    // try SSO-recovery first (matches oauthRoutes.js:262 / adminRoutes.js:366),
    // and fall back to the deterministic master-key derivation. Without
    // this, chat.js:239 reads `req.session?.encryptionKey === undefined`
    // and fails on encrypted-conversation lookup.
    //
    // Cached: PBKDF2 with 210k iterations is too expensive to do on
    // every request. Both the SSO-recovery DEK and the deterministic
    // fallback are stable for the user's lifetime (until they explicitly
    // rotate via the encryption-pin flow), so first computation wins.
    /** @type {string | null} */
    let cachedEnc = null;
    try {
        cachedEnc = _encKeyCache.get(user.id);
        if (!cachedEnc) {
            const sso = await encryption.getOrCreateSSOUserDEKCompat(user.id, true);
            if (sso?.encryptionKey) {
                cachedEnc = sso.encryptionKey;
            } else if (process.env.MASTER_ENCRYPTION_KEY) {
                cachedEnc = encryption.getFallbackEncryptionKey(user.id);
            }
            if (cachedEnc) _encKeyCache.set(user.id, cachedEnc);
        }
    } catch (e) {
        log.warn(`[ConnectorJWT] EncryptionKey derivation failed for user ${user.id}: ${/** @type {Error} */ (e).message}`);
        orgHealth.problem('auth.encryption_key_failed', {
            orgId, source: 'connectorJwt', req,
            meta: { userId: user.id, reason: 'derivation_failed' },
        });
    }

    // In-memory session only — deliberately NOT establishSession. The
    // connector strips the request cookie (nextcloud-connector/
    // src/proxy.js), so a persisted row can never be read back: every
    // embedded request re-enters this middleware with a fresh JWT. The
    // old establishSession call here regenerated + INSERTed a
    // user_sessions row per API call (~15 per embedded page load) —
    // write-only garbage that grew the session table and slowed every
    // embedded request. Session fixation is moot without a cookie, so
    // the canonical shape is applied directly and persistence is
    // neutralised for this request — the Set-Cookie too, which AppAPI
    // would otherwise hand to the browser (see suppressSessionPersistence).
    // connectorOrgId/connectorNcUid feed
    // server/integrations/nextcloudClient.js resolveConnectorAuth().
    Object.assign(req.session, {
        isAuthenticated: true,
        user: sessionUser,
        isAdmin: user.role === 'admin',
        connectorOrgId: orgId,
        connectorNcUid: ncUid,
        ...(cachedEnc ? { encryptionKey: cachedEnc } : {}),
    });
    suppressSessionPersistence(req);
    // Fully authenticated — record org liveness. The emitter throttles
    // in-memory (1 write / org / 15 min), so this stays off the hot path.
    orgHealth.touchLiveness(orgId, 'authOk');
    return ok(user);
}

module.exports = {
    reject,
    fail,
    ok,
    crossTenantGate,
    pendingApprovalGate,
    findByNcUid,
    emailMatchGate,
    reconcileUserRecord,
    _linkDeps,
    establishConnectorSession,
    _isOrgAdminRequester,
    _resolveRequesterNcUid,
    _resolveSessionNcUid,
};

/** @typedef {NonNullable<Awaited<ReturnType<typeof userStore.getUser>>>} UserRec */

/** @typedef {NonNullable<Awaited<ReturnType<typeof userStore.getOrganization>>>} OrgRec */

/** @typedef {{ sub?: string, email?: string, name?: string, nc_admin?: boolean }} ConnectorPayload The verified JWT claims this module reads. */

/** @typedef {import('express').Request & { connectorAuth?: { orgId: string, ncUid: string | null } }} ConnectorReq */
