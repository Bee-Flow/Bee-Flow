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
const { orgHealth } = require('./connector/serviceDeps');
const log = require('../telemetry/log');
const { fallback } = require('../utils/bestEffort');

/** @typedef {{ kind: 'reject', status: number, body: object }} Reject */
/** @typedef {{ kind: 'error', error: Error }} Fail */
/** @typedef {{ kind: 'ok', user: any }} Ok */

/** @param {number} status @param {{ error: string; code?: string; }} body @returns {Reject} */
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
 * Defence in depth: the JWT was signed with org X's key, so the user it
 * identifies must belong to org X. Returns a reject outcome for a user bound
 * to a different org, null otherwise (no org, or the same org).
 */
function crossTenantGate(req, user, orgId) {
    if (!(user.organizationId && user.organizationId !== orgId)) return null;
    // Defence in depth: the JWT was signed with org X's key, so the user
    // it identifies must belong to org X. Refusing here prevents a stolen
    // tenant key from being used to act on users in other tenants.
    log.warn(`[ConnectorJWT] Cross-tenant rejection: user ${user.id} (org=${user.organizationId}) presented org=${orgId}'s key`);
    orgHealth.problem('auth.blocked_org_mismatch', {
        orgId, source: 'connectorJwt', req,
        meta: { userOrgId: user.organizationId, reason: 'user_bound_to_other_org' },
    });
    return reject(403, {
        error: 'This Nextcloud is connected to a different Bee Flow organisation than your account. Ask an admin of your organisation to generate a pairing code (Settings → Organisation → Nextcloud Sync → "Pair a new Nextcloud") and re-pair this Nextcloud with it.',
        code: 'NC_ORG_MISMATCH',
    });
}

/** Reject a user whose account still awaits admin approval; null = pass. */
function pendingApprovalGate(req, user, orgId) {
    if (user.status !== 'pending') return null;
    orgHealth.problem('auth.blocked_pending_approval', {
        orgId, source: 'connectorJwt', req,
        meta: { lastUserId: user.id, reason: 'existing_user_pending' },
    });
    return reject(403, { error: 'Account is pending admin approval' });
}

/**
 * Keep the DB row and the session coherent: backfill a missing org pointer,
 * log data anomalies, repair a stale nc_uid. Each step swallows its own
 * failure (warn, or silently for the read-only anomaly lookup).
 */
async function reconcileUserRecord(user, orgId, payload) {
    // Reconcile a missing org pointer. We reach here only when the user
    // either already belongs to `orgId` or has no org at all (the
    // cross-tenant guard above rejects a user bound to a *different* org).
    // The session below would otherwise fall back to `orgId` while the DB
    // row keeps a falsy organizationId — so embedded (session-org) and
    // standalone (`/auth/user` reads the DB row) would resolve different
    // orgs for the same person, and org-scoped queries that read the DB
    // (resolveUserOrgIds) would exclude them. Persist the org so DB and
    // session agree everywhere. Idempotent.
    if (!user.organizationId && orgId) {
        try {
            await userStore.updateUser(user.id, { organizationId: orgId });
            user.organizationId = orgId;
            log.info(`[ConnectorJWT] Backfilled organizationId=${orgId} for user ${user.id}`);
        } catch (e) {
            log.warn(`[ConnectorJWT] Failed to backfill organizationId for ${user.id}: ${/** @type {Error} */ (e).message}`);
        }
    }

    // Observability: surface data-corruption — a user marked as connector-
    // sourced should always live under an NC-bound org. If we ever see
    // provider=nextcloud_connector under an org without nc_instance_id,
    // that's a sign of broken state (manual edit, failed migration, or a
    // standalone-tenant data leak). Pure log; behaviour unchanged. Only
    // resolves the org for connector-sourced users so non-NC traffic
    // doesn't pay an extra DB roundtrip.
    if (user.provider === 'nextcloud_connector') {
        const orgForCheck = await userStore.getOrganization(user.organizationId || orgId).catch((err) => fallback('connectorJwtPhases:org-anomaly-check', err, null));
        if (orgForCheck && !orgForCheck.nc_instance_id) {
            log.warn(`[ConnectorJWT] Data anomaly: user ${user.id} has provider=nextcloud_connector but org ${orgForCheck.id} has no nc_instance_id`);
        }
    }

    // Self-heal a wrong stored nc_uid. Historical bug: connectorBootstrap's
    // `if (!user.ncUid)` guard checked the camelCase spelling on a raw
    // snake_case row, so EVERY bootstrap overwrote nc_uid with admins[0] —
    // and since the stored uid wins below, an affected user's WebDAV calls
    // impersonated the wrong NC account. payload.sub is signed with this
    // org's tenant key (verified above), so when the requester's own uid
    // disagrees with the stored one AND the email matches, the row is
    // stale — repair it. Email must match so a shared/recycled Bee Flow
    // account can never be rebound to a different person's NC identity.
    if (user.nc_uid && payload.sub && user.nc_uid !== payload.sub
        && user.email && payload.email && user.email === payload.email) {
        try {
            await userStore.updateUser(user.id, { ncUid: payload.sub });
            log.warn(`[ConnectorJWT] Repaired stale nc_uid for user ${user.id}: ${user.nc_uid} → ${payload.sub}`);
            user.nc_uid = payload.sub;
        } catch (e) {
            log.warn(`[ConnectorJWT] Failed to repair nc_uid for ${user.id}: ${/** @type {Error} */ (e).message}`);
        }
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
    reconcileUserRecord,
    establishConnectorSession,
    _isOrgAdminRequester,
    _resolveRequesterNcUid,
    _resolveSessionNcUid,
};

/** @typedef {NonNullable<Awaited<ReturnType<typeof userStore.getUser>>>} UserRec */

/** @typedef {NonNullable<Awaited<ReturnType<typeof userStore.getOrganization>>>} OrgRec */

/** @typedef {{ sub?: string, email?: string, name?: string, nc_admin?: boolean }} ConnectorPayload The verified JWT claims this module reads. */

/** @typedef {import('express').Request & { connectorAuth?: { orgId: string, ncUid: string | null } }} ConnectorReq */
