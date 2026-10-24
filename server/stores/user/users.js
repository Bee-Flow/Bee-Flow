// @typecheck
// Users — CRUD, avatar/directory reads, the account-deletion cascade, and the
// atomic seat-cap creation path.

const { run, getOne, getAll } = require('../../db');
const { initDB } = require('./schema');
const { dynamicUpdate, parseJSON } = require('./shared');
const log = require('../../telemetry/log');
const { eraseSuggestionTraces, stagesRunBy, assertNotStageRunAs, eraseCmsUploadTickets, deleteUser } = require('./usersDelete');
const { sanitizeUserNames, isNewCredential, createUser, SeatCapExceededError, createUserWithSeatCheck } = require('./usersCreate');
const { setSeatSync } = require('./seatSyncPort');
const { bestEffort } = require('../../utils/bestEffort');

// Stripe seat sync for usersCreate.js / usersDelete.js (they must not require the
// billing services: see seatSyncPort.js). Required lazily, as before.
setSeatSync(async (orgId) => {
    const { syncSeatQuantityForOrg } = require('../../services/stripeService');
    await syncSeatQuantityForOrg(orgId);
});

// ── Users ─────────────────────────────
async function getAllUsers() {
    await initDB();
    // Excludes avatar (base64 blob, up to 200 KB per user) from list queries —
    // callers that need the avatar should use getUser(id) or getAllUserAvatars().
    //
    // Excludes envelope-encryption material too — "masterWrappedDEK",
    // "wrappedDEK", "kekSalt", "recoverySalt", "recoveryWrappedDEK". This list is
    // served straight to the client by GET /auth/users (adminRoutes.js), so every
    // holder of org_admin / admin_security / manage_users used to receive every
    // visible user's wrapped DEKs AND their KDF salts — the complete input set for
    // an offline attack on a member's password, with no server involved. The keys
    // are wrapped rather than plaintext, so this was a weakening of the
    // zero-knowledge model rather than a key leak, but on this product that is
    // still not something to hand out with a user list.
    //
    // Nothing needs them from here: the only readers are auth/encryption.js and
    // auth/opaqueRoutes.js, and both resolve a single user via getUser(id).
    // If a future caller genuinely needs them in bulk, add getAllUsersWithKeys()
    // and leave this one safe by default — do not widen this SELECT.
    //
    // mfa_enabled and last_seen_at ARE here: the admin user list is exactly the
    // screen that has to show who still has no second factor and who has stopped
    // showing up, and both are facts about the account rather than material an
    // attacker can use. password_changed_at is deliberately NOT here — the only
    // consumer is a person's own security screen, which reads it from
    // /auth/user, and one org_admin does not need a per-colleague password-age
    // report to do their job.
    const rows = await getAll(`
        SELECT id, username, "displayName", "firstName", "lastName", email, phone,
               "avatarType", role, groups, "orgRole", "organizationId",
               "ssoEncryptionSetup", "passwordResetRequired",
               "dekUnwrapFailures", "dekLockoutUntil", "kdfMode", "createdAt",
               status, "activeIconPackId", "azureUserId", "azureTenantId",
               "nc_uid", "provider", "auto_provisioned",
               mfa_enabled, last_seen_at
        FROM users
    `);
    // The raw columns stay on the row (nc_uid/provider/auto_provisioned already
    // travel that way), with camelCase aliases alongside so clients can read
    // these two like every other field. Additive on purpose: the web and mobile
    // clients ignore what they do not know, and renaming would break them.
    return rows.map(u => ({
        ...u,
        groups: parseJSON(u.groups, []),
        mfaEnabled: !!u.mfa_enabled,
        lastSeenAt: u.last_seen_at || null,
    }));
}

// Lightweight list that *does* include the avatar blob. Use only when callers
// need to render avatars for many users (e.g. the usage / monitoring page).
async function getAllUserAvatars() {
    await initDB();
    return getAll(`SELECT id, username, "displayName", "avatarType", avatar FROM users`);
}

/**
 * Avatar/display info for a specific set of user ids — one indexed query
 * instead of the full-table scan above. Used by the monitoring endpoints,
 * which only ever need the handful of users appearing in the current page.
 */
async function getUserAvatarsByIds(ids) {
    const list = Array.from(new Set(ids || [])).filter(Boolean);
    if (list.length === 0) return [];
    await initDB();
    return getAll(`SELECT id, username, "displayName", "avatarType", avatar FROM users WHERE id = ANY($1)`, [list]);
}


/**
 * The people in one organisation, for a person picker inside a Studio app.
 *
 * DO NOT WIDEN THIS SELECT — the same rule as getAllUsers, and here it binds
 * harder. Every other directory read on this server is gated behind an admin
 * permission (manage_users / org_admin / admin_compliance). This one is reached
 * by anyone who can OPEN a published app, so it returns the least a picker can
 * work with: who they are and what to call them.
 *
 * No e-mail. A picker needs a label, not an address, and e-mail here would turn
 * one published app into an address-book export for the whole organisation.
 * Two colleagues with the same display name are told apart by `username`, which
 * is not a way to reach anybody.
 *
 * No avatar. The column is a base64 blob up to ~200 KB; a 200-person org would
 * be tens of megabytes on a control that shows twenty rows. Callers render a
 * monogram, and `avatarType` says whether a real photo exists for a future
 * batched lookup (getUserAvatarsByIds) over the ids actually on screen.
 *
 * Inactive accounts are left out: assigning work to someone who has left is a
 * bug you find out about weeks later.
 */
async function getOrgMembersForDirectory(organizationId, limit = 500) {
    if (!organizationId) return [];
    await initDB();
    const capped = Math.max(1, Math.min(1000, Number(limit) || 500));
    return getAll(`
        SELECT id, "displayName", username, "avatarType"
        FROM users
        WHERE "organizationId" = $1
          AND COALESCE(status, 'active') = 'active'
        ORDER BY COALESCE(NULLIF("displayName", ''), username) ASC
        LIMIT $2
    `, [organizationId, capped]);
}

async function getUser(userId) {
    await initDB();
    const u = await getOne('SELECT * FROM users WHERE id = $1', [userId]);
    if (!u) return null;
    return {
        ...u, groups: parseJSON(u.groups, []), appPassword: parseJSON(u.appPassword, u.appPassword),
        masterWrappedDEK: parseJSON(u.masterWrappedDEK, u.masterWrappedDEK), wrappedDEK: parseJSON(u.wrappedDEK, u.wrappedDEK),
        recoveryWrappedDEK: parseJSON(u.recoveryWrappedDEK, u.recoveryWrappedDEK),
        dekUnwrapFailures: u.dekUnwrapFailures || 0, ssoEncryptionSetup: u.ssoEncryptionSetup || 0,
        recoveryUnwrapFailures: u.recoveryUnwrapFailures || 0,
        passwordResetRequired: u.passwordResetRequired || 0
    };
}

async function getUserByEmail(email) {
    await initDB();
    const u = await getOne('SELECT * FROM users WHERE LOWER(email) = LOWER($1)', [email]);
    if (!u) return null;
    return {
        ...u, groups: parseJSON(u.groups, []), appPassword: parseJSON(u.appPassword, u.appPassword),
        masterWrappedDEK: parseJSON(u.masterWrappedDEK, u.masterWrappedDEK), wrappedDEK: parseJSON(u.wrappedDEK, u.wrappedDEK),
        recoveryWrappedDEK: parseJSON(u.recoveryWrappedDEK, u.recoveryWrappedDEK),
        dekUnwrapFailures: u.dekUnwrapFailures || 0, ssoEncryptionSetup: u.ssoEncryptionSetup || 0,
        recoveryUnwrapFailures: u.recoveryUnwrapFailures || 0,
        passwordResetRequired: u.passwordResetRequired || 0
    };
}

// Look up a user by the SHA-256 hash of a password-reset token. Returns the
// raw row (callers check password_reset_expires_at). No JSON parsing needed.
async function getUserByPasswordResetToken(tokenHash) {
    if (!tokenHash) return null;
    await initDB();
    return getOne('SELECT * FROM users WHERE password_reset_token_hash = $1', [tokenHash]);
}

// Look up a user by the SHA-256 hash of an email-verification token. Returns
// the raw row (callers check email_verification_expires_at). The raw token
// only ever lives in the emailed verification link.
async function getUserByEmailVerificationToken(tokenHash) {
    if (!tokenHash) return null;
    await initDB();
    return getOne('SELECT * FROM users WHERE email_verification_token_hash = $1', [tokenHash]);
}

/**
 * The id of the org member with this address, or null.
 *
 * Deliberately NARROW, and deliberately org-pinned. `getUserByEmail` above is a
 * platform-wide lookup — right for signing in, wrong for anything that answers a
 * question on behalf of one tenant: it will happily confirm that an address
 * belongs to somebody in another organisation. The DSR discovery scan asks
 * exactly that question, so it asks it here instead.
 *
 * It returns an id and nothing else on purpose. The caller wants to know "is
 * this person one of ours"; handing back the whole row would put wrapped DEKs
 * and reset-token hashes into a compliance report's reach for no reason.
 */
async function findOrgMemberIdByEmail(organizationId, email) {
    if (!organizationId || !email) return null;
    await initDB();
    const u = await getOne(
        'SELECT id FROM users WHERE LOWER(email) = LOWER($1) AND "organizationId" = $2',
        [email, organizationId],
    );
    return u?.id || null;
}

async function getUserByNcUid(organizationId, ncUid) {
    if (!organizationId || !ncUid) return null;
    await initDB();
    const u = await getOne('SELECT * FROM users WHERE "organizationId" = $1 AND "nc_uid" = $2', [organizationId, ncUid]);
    if (!u) return null;
    // Match the shape produced by getUser/getUserByEmail — JSON columns are
    // parsed so callers can rely on `groups` being an array. Without this
    // ncUserGroupSync's group-diff comparisons silently rewrite every sync.
    return { ...u, groups: parseJSON(u.groups, []), appPassword: parseJSON(u.appPassword, u.appPassword) };
}

// ── Solution stages: the run-as wall (design 3.1, 3.4) ─────────────
//
// A Solution's UAT and PRD stages run as one account (`run_as_user_id`, in
// v1 the Solution owner), which owns every part deployed there: cross-owner
// edges refuse at run time. Deleting that account would drop the stage
// tables with it (the private-table rule below), and moving it out of the
// organisation strands every part. So both are refused (409 stage_run_as)
// while the account runs or owns a stage; an org admin can detach or remove
// the stages first.

async function updateUser(userId, updates) {
    await initDB();
    const existing = await getOne('SELECT * FROM users WHERE id = $1', [userId]);
    if (!existing) return false;

    // Every path that moves a member out of (or between) organisations ends
    // here: an account that runs a stage of its organisation stays put.
    if (updates.organizationId !== undefined && (updates.organizationId || '') !== (existing.organizationId || '')) {
        await assertNotStageRunAs(userId, { organizationId: existing.organizationId || '' });
    }

    // Same choke point as createUser — see the note there. Only the name
    // fields, and only when the caller actually supplied them, so a partial
    // update (a token write, a DEK rewrap) is untouched.
    updates = { ...updates, ...sanitizeUserNames(updates, { onlyPresent: true }) };

    // Every path that writes a new password hash also dates it, at the one point
    // they all pass through: the admin edit form, the admin reset, self-service
    // change-password, and the e-mailed reset link. A caller that knows better
    // (OPAQUE registration, where the credential is not a bcrypt hash) supplies
    // `passwordChangedAt` itself and is left alone.
    if (isNewCredential(updates) && updates.passwordChangedAt === undefined) {
        updates = { ...updates, passwordChangedAt: new Date() };
    }

    const serializeDek = (val) => {
        if (val === null) return null;
        if (val === undefined) return undefined;
        return typeof val === 'string' ? val : JSON.stringify(val);
    };

    // Build update map: jsKey → dbCol
    const updateMap = {};
    const colMap = {
        username: 'username', displayName: 'displayName', firstName: 'firstName', lastName: 'lastName',
        email: 'email', phone: 'phone', avatar: 'avatar', avatarType: 'avatarType',
        passwordHash: 'passwordHash', role: 'role', orgRole: 'orgRole', organizationId: 'organizationId',
        kekSalt: 'kekSalt', recoverySalt: 'recoverySalt', ssoEncryptionSetup: 'ssoEncryptionSetup',
        passwordResetRequired: 'passwordResetRequired', dekUnwrapFailures: 'dekUnwrapFailures',
        dekLockoutUntil: 'dekLockoutUntil',
        recoveryUnwrapFailures: 'recoveryUnwrapFailures', recoveryLockoutUntil: 'recoveryLockoutUntil',
        orgWrappedDEK: 'orgWrappedDEK',
        opaqueRecord: 'opaqueRecord', kdfMode: 'kdfMode',
        status: 'status', activeIconPackId: 'activeIconPackId', azureUserId: 'azureUserId', azureTenantId: 'azureTenantId',
        ncUid: 'nc_uid', provider: 'provider', autoProvisioned: 'auto_provisioned',
        // MFA (TOTP) + self-service password reset
        mfaEnabled: 'mfa_enabled', mfaSecret: 'mfa_secret', mfaEnrolledAt: 'mfa_enrolled_at',
        mfaRecoveryCodes: 'mfa_recovery_codes', mfaRecoveryCodesGeneratedAt: 'mfa_recovery_codes_generated_at',
        passwordResetTokenHash: 'password_reset_token_hash', passwordResetExpiresAt: 'password_reset_expires_at',
        // Email verification + locale
        emailVerificationTokenHash: 'email_verification_token_hash', emailVerificationExpiresAt: 'email_verification_expires_at',
        emailVerifiedAt: 'email_verified_at', preferredLocale: 'preferred_locale',
        // Account activity + credential age. Both need an entry here or
        // dynamicUpdate drops the key without a word — the exact way
        // recoveryUnwrapFailures stayed dead code for a year (see the note in
        // schema.js). lastSeenAt is normally written by touchLastSeen below,
        // not through here; the mapping exists so a caller that does reach for
        // updateUser gets a write instead of silence.
        lastSeenAt: 'last_seen_at', passwordChangedAt: 'password_changed_at',
    };

    for (const jsKey of Object.keys(colMap)) {
        if (updates[jsKey] !== undefined) updateMap[jsKey] = updates[jsKey];
    }

    // Special serialization
    if (updates.groups !== undefined) updateMap.groups = JSON.stringify(updates.groups);
    if (updates.wrappedDEK !== undefined) updateMap.wrappedDEK = serializeDek(updates.wrappedDEK);
    if (updates.masterWrappedDEK !== undefined) updateMap.masterWrappedDEK = serializeDek(updates.masterWrappedDEK);
    if (updates.recoveryWrappedDEK !== undefined) updateMap.recoveryWrappedDEK = serializeDek(updates.recoveryWrappedDEK);

    try {
        const fullColMap = { ...colMap, groups: 'groups', wrappedDEK: 'wrappedDEK', masterWrappedDEK: 'masterWrappedDEK', recoveryWrappedDEK: 'recoveryWrappedDEK' };
        const q = dynamicUpdate('users', userId, updateMap, fullColMap);
        if (q) await run(q.sql, q.params);

        // Per-seat plans rebill when the active-user count changes. Creation and
        // deletion already trigger a Stripe seat sync; status transitions
        // (approve a pending user, SSO activation, NC group activate/deactivate)
        // funnel through here, so this is the single chokepoint that keeps
        // billing immediate for those paths too. Only fire when the status
        // actually crosses the active boundary. Fire-and-forget — a Stripe
        // outage must never block the user update; the 15-min drift cron is the
        // backstop. proration_behavior:'create_prorations' charges on increase
        // and credits on decrease.
        if (updates.status !== undefined && existing.organizationId) {
            const wasActive = (existing.status ?? 'active') === 'active';
            const nowActive = (updates.status ?? existing.status ?? 'active') === 'active';
            if (wasActive !== nowActive) {
                Promise.resolve().then(async () => {
                    try {
                        const { syncSeatQuantityForOrg } = require('../../services/stripeService');
                        await syncSeatQuantityForOrg(existing.organizationId);
                    } catch (err) { bestEffort('stores/user/users:updateUser', err); /* best-effort */ }
                });
            }
        }
        return true;
    } catch (e) { log.error(e); return false; }
}

/**
 * Record that we just saw this account (B15).
 *
 * Deliberately the narrowest possible write: one UPDATE, no read, no branches.
 * updateUser is the wrong tool here — it first does `SELECT * FROM users` and
 * then decides whether to talk to Stripe about seat counts, which is a lot of
 * machinery to hang off the request path for a single timestamp.
 *
 * The throttle that decides WHETHER this runs lives in requireAuth
 * (auth/permissions.js): one write per user per window, so a busy account costs
 * one UPDATE per quarter of an hour rather than one per request. This function
 * only performs the write.
 *
 * NOW() rather than a JS timestamp: with several pods writing the same column,
 * the database clock is the only one they agree on. Errors are swallowed —
 * last-seen is bookkeeping, not a gatekeeper, and nobody should be locked out
 * of the product because their activity clock could not be updated.
 */
async function touchLastSeen(userId) {
    if (!userId) return false;
    try {
        await initDB();
        const { rowCount } = await run('UPDATE users SET last_seen_at = NOW() WHERE id = $1', [userId]);
        return rowCount > 0;
    } catch (_) {
        // Silent on purpose: this sits behind (nearly) every authenticated
        // request, so a database hiccup would turn one incident into a log
        // flood without telling anyone anything the DB errors do not already.
        return false;
    }
}

/**
 * Replace a stored password hash with a re-encoding of the SAME password
 * (auth/login/passwordRehash.js: bcrypt → argon2id after a successful sign-in).
 *
 * Not updateUser, for two reasons. The credential did not change, so
 * `password_changed_at` must not move (updateUser would date it unless told
 * otherwise). And the write is a compare-and-swap on the hash the sign-in just
 * verified: if the password was changed or reset in the meantime, the newer
 * hash wins and this write does nothing.
 *
 * @param {string} userId
 * @param {string} expectedHash  the hash the password was verified against
 * @param {string} newHash
 * @returns {Promise<boolean>} whether the row was updated
 */
async function replacePasswordHash(userId, expectedHash, newHash) {
    if (!userId || !expectedHash || !newHash) return false;
    await initDB();
    const { rowCount } = await run(
        'UPDATE users SET "passwordHash" = $1 WHERE id = $2 AND "passwordHash" = $3',
        [newHash, userId, expectedHash],
    );
    return rowCount > 0;
}

module.exports = {
    getAllUsers, getAllUserAvatars, getUserAvatarsByIds, getOrgMembersForDirectory,
    getUser, getUserByEmail, getUserByPasswordResetToken, getUserByEmailVerificationToken,
    createUser, updateUser, deleteUser, eraseSuggestionTraces, eraseCmsUploadTickets, getUserByNcUid, findOrgMemberIdByEmail,
    stagesRunBy, assertNotStageRunAs,
    createUserWithSeatCheck, SeatCapExceededError,
    touchLastSeen, isNewCredential, replacePasswordHash,
};
