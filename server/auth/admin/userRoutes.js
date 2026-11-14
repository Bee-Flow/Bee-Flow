// @typecheck
/**
 * Admin Routes — user management: list/create/update/delete, MFA reset,
 * avatars and the self-service password change. Split out of
 * auth/adminRoutes.js; mounted there first, in the original registration order.
 */

const express = require('express');
const passwords = require('../passwordHash');
const fs = require('fs');
const path = require('path');
const { receiveImage } = require('../../middleware/uploadedImage');
const log = require('../../telemetry/log');
const { bestEffort, fallback } = require('../../utils/bestEffort');
const { isPlatformOperator } = require('../platformOperator');
const { costLimitRefusal, imageLimitsRefusal, stripKeyMaterial, CreateUserBody, ChangePasswordBody, isKnownRoleId, needsAdminPasswordFloor, unknownFieldsRefusal, endSessionsFor, leavesServerWithoutPlatformAdmin, refusedDelete } = require('./userSupportRoutes');
const router = express.Router();

const userStore = require('../../stores/userStore');
const { loadConfig, requireAuth, getUserPermissions, invalidatePermissionCache, resolveUserOrgIds, resolveAdminOrgId } = require('../permissions');
const { rewrapUserDEKCompat, adminResetUser } = require('../encryption');
// One password policy for every write path. Without it /change-password would
// accept 4 characters and the admin create / update paths would hash whatever
// they were handed — so an account provisioned or "reset" through the admin
// panel could carry a one-character password while signup and password-reset
// enforce 8.
const { validatePassword } = require('../passwordPolicy');
const { checkResourceLimits } = require('../../core/entitlements/limits');
const { validate } = require('../../core/http/validate');
const { bodyOf } = require('../../core/http/schemaParts');
const {
    repairIfOrphaned,
    refuseLastOrgAdmin,
    requireOrgAdminForUser,
    defaultGroupsRefused,
    credentialResetRefusal,
} = require('./orgAdminGuards');
const { LAST_PLATFORM_ADMIN_REFUSAL } = require('./platformAdminCount.mts');
const { roleValueRefusal, userSnapshot, userUpdatesFrom, orgAdminGuard, afterUserUpdate } = require('./userUpdateSupportRoutes');

/**
 * A new password on PUT /users/:id. Same policy as signup and password reset:
 * the e-mail/username context lets the validator reject passwords derived from
 * the account itself, and the target's post-update reach decides which minimum
 * length applies. On success its hash is put on `updates`. With `oldPassword`
 * (the person changing their own) the encryption key is re-wrapped; without
 * it (an admin reset) the zero-knowledge key is reset. Answers 400 and returns
 * true when it refuses.
 * @param {import('express').Response} res
 * @param {{ id: string, password: string, oldPassword?: string, prevUser: Record<string, any> | null, updates: Record<string, any> }} change
 */
async function refusedPassword(res, { id, password, oldPassword, prevUser, updates }) {
    const pwCheck = validatePassword(password, {
        username: prevUser?.username || id,
        email: updates.email ?? prevUser?.email,
        isAdmin: needsAdminPasswordFloor({
            role: updates.role ?? prevUser?.role,
            orgRole: updates.orgRole ?? prevUser?.orgRole,
        }),
    });
    if (!pwCheck.ok) {
        res.status(400).json({ error: pwCheck.error, ...(pwCheck.code ? { code: pwCheck.code } : {}) });
        return true;
    }

    updates.passwordHash = await passwords.hash(password);

    if (!oldPassword) {
        // Admin-initiated password reset — destructive (zero-knowledge)
        await adminResetUser(id);
        log.warn(`[Auth] Admin reset user ${id} — encrypted data requires recovery key`);
        return false;
    }
    // User-initiated password change — rewrap DEK
    try {
        const result = await rewrapUserDEKCompat(id, oldPassword, password);
        if (result.success) return false;
    } catch (err) {
        log.error('[Auth] DEK rewrap failed:', /** @type {Error} */ (err).message);
    }
    res.status(400).json({ error: 'Failed to verify old password' });
    return true;
}

// Who may list users, and the admin dashboard's `?scope=admin` list (auth/admin/userListScope.mts).
/** @type {ReturnType<typeof import('./userListScope.mts').createUserListScope<import('express').Request, Record<string, any>>>} */
const { mayViewUsers, adminScopedUsers } = require('./userListScope.mts').createUserListScope({
    getUserPermissions: (userId, session) => getUserPermissions(userId, session),
    resolveAdminOrgId: (req) => resolveAdminOrgId(req),
    getAllUsers: () => userStore.getAllUsers(),
    getAllGroups: () => userStore.getAllGroups(),
    isPlatformOperator: (u) => isPlatformOperator(u),
    stripKeyMaterial: (u) => stripKeyMaterial(u),
});

// === User Management API (Admin Only) ===

// Get all users — requires manage_users, admin_security, or org_admin.
// `?scope=admin`: see adminScopedUsers.
router.get('/users', requireAuth, async (req, res) => {
    // Non-super-admins must have user management permissions
    const isSuperAdmin = req.session.isAdmin || req.session.user?.role === 'admin';
    if (!(await mayViewUsers(req))) {
        return res.status(403).json({ error: 'Permission required to view users' });
    }

    const scoped = await adminScopedUsers(req);
    if (scoped) return res.json(scoped);

    const users = await userStore.getAllUsers();
    const config = await loadConfig();
    const superAdmin = {
        id: 'admin',
        username: config.admin.username,
        displayName: 'Administrator (System)',
        role: 'admin',
        isSystem: true
    };

    let allUsers = [superAdmin, ...users.filter(u => !isPlatformOperator(u))];

    // Org-scoped filtering using canonical resolver.
    //
    // `resolveUserOrgIds` returns null ONLY for super-admins (already handled
    // above via isSuperAdmin), so for any non-super caller it returns a Set —
    // possibly empty. We ALWAYS apply the filter for non-super callers: an
    // empty org set must scope DOWN to "self only", never widen to "all users".
    // The previous `if (myOrgIds.size > 0)` guard silently returned every user
    // in the system when the caller's `organizationId` was falsy/missing — a
    // cross-org leak. The caller is always allowed to see their own row so an
    // org-admin whose own org pointer is momentarily off still sees themselves.
    if (!isSuperAdmin) {
        const myOrgIds = (await resolveUserOrgIds(req)) || new Set();
        const selfId = req.session.user?.id;
        const allGroups = await userStore.getAllGroups();
        const orgGroupIds = new Set();
        for (const group of allGroups) {
            if (group.organizationId && myOrgIds.has(group.organizationId)) {
                orgGroupIds.add(group.id);
            }
        }

        allUsers = allUsers.filter(u => {
            if (u.isSystem) return false;
            if (selfId && u.id === selfId) return true;
            if (u.organizationId && myOrgIds.has(u.organizationId)) return true;
            let uGroups = [];
            try { uGroups = Array.isArray(u.groups) ? u.groups : JSON.parse(u.groups || '[]'); } catch (_) { uGroups = fallback('auth/admin/users:groupsJson', _, []); } // no group membership
            return uGroups.some(gid => orgGroupIds.has(gid));
        });
    }

    res.json(allUsers.map(stripKeyMaterial));
});

// Create user
router.post('/users', requireOrgAdminForUser, validate({ body: CreateUserBody }), async (req, res) => {
    const { username, displayName, firstName, lastName, email, phone, avatar, avatarType, password, role, groups, orgRole, organizationId } = req.body;

    if (isPlatformOperator(username)) {
        return res.status(400).json({ error: 'Cannot create user "admin"' });
    }

    // Same two rules as the update path. The platform role is an operator's to
    // set, and it must name a role this installation defines — otherwise create
    // is simply a second door onto the field update just closed.
    const callerIsSuperAdmin = req.session?.isAdmin || req.session?.user?.role === 'admin';
    if (role !== undefined && !callerIsSuperAdmin && role !== 'user') {
        return res.status(403).json({
            error: 'Cannot assign a platform role',
            code: 'role_change_denied',
        });
    }
    if (role !== undefined && !(await isKnownRoleId(role))) {
        return res.status(400).json({
            error: `Unknown role: ${String(role).slice(0, 64)}`,
            code: 'unknown_role',
        });
    }

    // A password an admin picks for someone else is still that person's login
    // credential, and this route hashed it unchecked — so the admin panel was a
    // way to mint accounts weaker than anything signup would ever accept. The
    // longer minimum applies when the account is being created with
    // administrative reach, because that is the credential worth guessing.
    const pwCheck = validatePassword(password, {
        username,
        email,
        isAdmin: needsAdminPasswordFloor({ role, orgRole }),
    });
    if (!pwCheck.ok) {
        return res.status(400).json({ error: pwCheck.error, ...(pwCheck.code ? { code: pwCheck.code } : {}) });
    }

    // Pre-flight UX hint — atomic enforcement happens inside
    // createUserWithSeatCheck (which holds a row lock and re-counts inside
    // the transaction). Without this hint the API still rejects but the
    // user sees a generic create_failed.
    const targetOrgId = organizationId || null;
    if (targetOrgId) {
        const allUsers = await userStore.getAllUsers();
        const orgUserCount = allUsers.filter(u => u.organizationId === targetOrgId).length;
        // `await` — checkResourceLimits is async (core/limits.js:313). Without
        // it this compared a PROMISE for truthiness, which is always true, so
        // every attempt to create a user inside an organisation was refused
        // with 403 and a body of {"error":{}} — a Promise serialised by
        // res.json(). Found while verifying the org-admin fixes against a live
        // stack: adding a second member to a tenant was simply impossible.
        // routes/knowledge.js:173 calls the same helper correctly.
        const limitErr = await checkResourceLimits(targetOrgId, 'users', orgUserCount);
        if (limitErr) {
            return res.status(403).json({ error: limitErr });
        }
    }

    // Merge the default groups of the TARGET organisation only, each through
    // the same check as the `groups` the caller sent.
    let finalGroups = Array.isArray(groups) ? [...groups] : [];
    if (targetOrgId) {
        try {
            const orgs = await userStore.getAllOrganizations();
            const org = orgs.find(o => o.id === targetOrgId);
            /** @type {string[]} */
            const defaults = Array.isArray(org?.defaultGroups) ? org.defaultGroups.map(String) : [];
            const refused = defaults.length ? new Set(await defaultGroupsRefused(req, targetOrgId, defaults)) : new Set();
            if (refused.size > 0) {
                log.warn(`[Auth] Skipped ${refused.size} default group(s) of org '${targetOrgId}' the caller may not assign`);
            }
            for (const gid of defaults) {
                if (!refused.has(gid) && !finalGroups.includes(gid)) finalGroups.push(gid);
            }
        } catch (e) {
            log.warn('[Auth] Failed to merge default groups:', /** @type {Error} */ (e).message);
        }
    }

    const passwordHash = await passwords.hash(password);
    const newUser = {
        id: username,
        username,
        displayName: displayName || username,
        firstName: firstName || null,
        lastName: lastName || null,
        email: email || null,
        phone: phone || null,
        avatar: avatar || null,
        avatarType: avatarType || null,
        passwordHash,
        role: role || 'user',
        groups: finalGroups,
        orgRole: orgRole || '',
        organizationId: organizationId || ''
    };

    try {
        const result = await userStore.createUserWithSeatCheck(newUser, { strict: true });
        if (result.created) {
            log.info(`[Audit] ${req.session.user?.id || 'system'} created user '${newUser.id}' in org '${organizationId || 'none'}' with orgRole '${orgRole || 'none'}'`);
            await userStore.logAccessAudit(
                'user.create',
                'user',
                newUser.id,
                req.session.user?.id || null,
                null,
                { username, displayName, role, orgRole: orgRole || '', organizationId: organizationId || null, groups: finalGroups },
                organizationId || null,
            );
            return res.json({ success: true, user: { id: newUser.id, username, displayName, role } });
        }
        if (result.reason === 'duplicate_id') return res.status(400).json({ error: 'User already exists' });
        return res.status(400).json({ error: result.error || 'User already exists' });
    } catch (e) {
        if (e instanceof userStore.SeatCapExceededError) {
            return res.status(403).json({ error: 'seat_cap_exceeded', current: e.current, max: e.max });
        }
        throw e;
    }
});

// Update user. The steps are in userUpdateSupportRoutes.js; this is their order, and
// every refusal is answered before anything is written.
router.put('/users/:id', requireOrgAdminForUser, async (req, res) => {
    const { id } = req.params;
    const body = req.body || {};

    // Anything outside the allow-list is refused instead of silently dropped:
    // a "success" for a change that did not happen is how a failed escalation
    // gets mistaken for a real one. Sibling refusals in this file already name
    // what they reject; this does the same.
    const refusal = unknownFieldsRefusal(body) || costLimitRefusal(body) || imageLimitsRefusal(body);
    if (refusal) return res.status(400).json(refusal);

    // Everything else is read through `updates` below.
    const { role, password, oldPassword, confirmSelfDemotion } = body;
    const roleRefusal = await roleValueRefusal(id, role);
    if (roleRefusal) return res.status(400).json(roleRefusal);

    const prevUser = await userSnapshot(id);
    const isSuperAdmin = req.session?.isAdmin || req.session?.user?.role === 'admin';
    const updates = userUpdatesFrom(body, prevUser, isSuperAdmin);
    const callerId = req.session?.user?.id;

    // The last organisation admin stays, and one's own demotion is confirmed.
    const guard = await orgAdminGuard({ id, prevUser, updates, callerId, confirmSelfDemotion });
    if (guard.lastOrgAdmin) return refuseLastOrgAdmin(res, 'That change');
    if (guard.refusal) return res.status(409).json(guard.refusal);

    // The last platform admin keeps the role and stays active (self-demotion of
    // the platform role is otherwise allowed; the panel asks first).
    if (await leavesServerWithoutPlatformAdmin(prevUser, { id, role: updates.role, status: updates.status })) {
        return res.status(409).json(LAST_PLATFORM_ADMIN_REFUSAL);
    }

    const resetRefusal = password ? await credentialResetRefusal(req, prevUser) : null;
    if (resetRefusal) return res.status(403).json(resetRefusal);
    if (password && await refusedPassword(res, { id, password, oldPassword, prevUser, updates })) return;

    if (!await userStore.updateUser(id, updates)) return res.status(404).json({ error: 'User not found' });

    // The pre-check is a read; this is the write. Two admins demoting each
    // other in parallel both pass the read. See repairIfOrphaned.
    if (guard.guardedOrgIds.length && await repairIfOrphaned(guard.guardedOrgIds, prevUser)) {
        return refuseLastOrgAdmin(res, 'That change');
    }

    const hint = await afterUserUpdate({ id, prevUser, updates, callerId, sessionID: req.sessionID, passwordChanged: !!password });
    res.json({ success: true, ...(hint ? { hint } : {}) });
});

// Reset a user's two-factor authentication. Org admins over their
// own members (enforced by requireOrgAdminForUser) or super-admins. Clears
// enrollment entirely; because `require_mfa_for_password_accounts` defaults
// on, the user is forced to re-enroll at their next login — so this unlocks a
// locked-out user without weakening the account long-term. Audited.
router.post('/users/:id/mfa/reset', requireOrgAdminForUser, validate({ body: bodyOf({}, 'A two-factor reset') }), async (req, res) => {
    const { id } = req.params;
    const target = await userStore.getUser(id);
    if (!target) return res.status(404).json({ error: 'User not found' });
    const resetRefusal = await credentialResetRefusal(req, target);
    if (resetRefusal) return res.status(403).json(resetRefusal);
    // Before the early return: a reset must leave no security key behind,
    // whatever state the MFA columns are in.
    const removedKeys = await userStore.deleteAllSecurityKeys(id);
    if (!target.mfa_enabled) return res.json({ success: true, wasEnabled: false });

    const ok = await userStore.updateUser(id, {
        mfaEnabled: false,
        mfaSecret: null,
        mfaEnrolledAt: null,
        mfaRecoveryCodes: null,
        mfaRecoveryCodesGeneratedAt: null,
    });
    if (!ok) throw new Error(`MFA reset: updateUser wrote nothing for '${id}'`);

    log.warn(`[Audit] ${req.session.user?.id || 'system'} reset 2FA for user '${id}'`);
    await userStore.logAccessAudit(
        'user.mfa_reset',
        'user',
        id,
        req.session.user?.id || null,
        { mfa_enabled: true, security_keys: removedKeys },
        { mfa_enabled: false, security_keys: 0 },
        target.organizationId || null,
    );
    await invalidatePermissionCache(id);
    res.json({ success: true, wasEnabled: true });
});

// Delete user
router.delete('/users/:id', requireOrgAdminForUser, async (req, res) => {
    const { id } = req.params;
    if (isPlatformOperator(id)) {
        return res.status(400).json({ error: 'Cannot delete system admin' });
    }

    // Capture the user snapshot before destruction so the audit row records
    // who was removed from which org.
    let prevUser = null;
    try { prevUser = await userStore.getUser(id); } catch (_) { prevUser = null; }

    // The last org admin of a populated organisation, and the last platform admin, stay.
    if (await refusedDelete(res, prevUser, id)) return;

    if (await userStore.deleteUser(id)) {
        log.info(`[Audit] ${req.session.user?.id || 'system'} deleted user '${id}'`);
        await userStore.logAccessAudit(
            'user.delete',
            'user',
            id,
            req.session.user?.id || null,
            prevUser ? {
                username: prevUser.username,
                role: prevUser.role,
                orgRole: prevUser.orgRole,
                organizationId: prevUser.organizationId,
                groups: prevUser.groups,
            } : null,
            null,
            prevUser ? prevUser.organizationId : null,
        );
        // Clear any stale permission cache for the deleted user so existing
        // sessions can't continue resolving against the cached snapshot.
        await invalidatePermissionCache(id);
        try {
            const { invalidateUserExistenceCache } = require('../permissions');
            await invalidateUserExistenceCache(id);
        } catch (err) { bestEffort('auth/admin/users:invalidateExistenceCache', err); }
        res.json({ success: true });
    } else {
        res.status(404).json({ error: 'User not found' });
    }
});

// Upload user avatar image. The type is read from the bytes and decides the
// stored extension (middleware/uploadedImage.js); the client's file name
// never does. Served back by the /uploads mount in boot/staticAssets.js.
const receiveAvatar = receiveImage({
    field: 'avatar',
    allow: ['image/png', 'image/jpeg', 'image/svg+xml', 'image/webp', 'image/gif'],
    name: (req) => `user-avatar-${String(req.params.id)}-${Date.now()}`,
});

router.post('/users/:id/avatar', requireOrgAdminForUser, receiveAvatar, async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const avatarPath = `/uploads/${req.file.filename}`;
    await userStore.updateUser(String(req.params.id), { avatar: avatarPath, avatarType: 'image' });
    res.json({ success: true, avatar: avatarPath, avatarType: 'image' });
});

router.delete('/users/:id/avatar', requireOrgAdminForUser, async (req, res) => {
    const user = await userStore.getUser(req.params.id); // nosemgrep: ajinabraham.njsscan.traversal.resolve_path_traversal.join_resolve_path_traversal -- user.avatar is the server-generated upload path, never request input
    if (user && user.avatar && user.avatarType === 'image') {
        const filePath = path.join(__dirname, '..', '..', 'data', user.avatar); // nosemgrep: javascript.express.security.audit.express-path-join-resolve-traversal.express-path-join-resolve-traversal -- user.avatar is the server-generated upload path stored by the avatar upload route, never request input
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    }
    // Use PostgreSQL to set NULL
    const { run } = require('../../db');
    await run('UPDATE users SET avatar = NULL, "avatarType" = NULL WHERE id = $1', [req.params.id]);
    res.json({ success: true });
});

// Change own password (user-facing, requires old password for DEK re-wrap)
router.post('/change-password', requireAuth, validate({ body: ChangePasswordBody }), async (req, res) => {
    const { oldPassword, newPassword } = req.body;
    const userId = req.session.user?.id;

    if (!userId) {
        return res.status(401).json({ error: 'Not authenticated' });
    }

    const user = await userStore.getUser(userId);
    if (!user || !user.passwordHash) {
        return res.status(404).json({ error: 'User not found' });
    }

    // This route enforced a FOUR character minimum while signup and password
    // reset both required eight — so the cheapest way to weaken any account on
    // the install was to sign in once and "change" the password to something
    // trivial. A pentester walked an account down to "12345678" through here.
    // The shared validator is the same one signup and reset use, and it gets the
    // account's own username/e-mail so it can refuse passwords derived from
    // them; admins and org-admins get the longer minimum their reach warrants.
    const pwCheck = validatePassword(newPassword, {
        username: user.username || userId,
        email: user.email,
        isAdmin: needsAdminPasswordFloor(user),
    });
    if (!pwCheck.ok) {
        return res.status(400).json({ error: pwCheck.error, ...(pwCheck.code ? { code: pwCheck.code } : {}) });
    }

    const isValid = await passwords.verify(oldPassword, user.passwordHash);
    if (!isValid) {
        return res.status(401).json({ error: 'Current password is incorrect' });
    }

    const result = await rewrapUserDEKCompat(userId, oldPassword, newPassword);
    if (!result.success) {
        throw new Error('Password change: the encryption key could not be unwrapped with the verified password');
    }

    const passwordHash = await passwords.hash(newPassword);
    await userStore.updateUser(userId, { passwordHash });

    // Every other session of this account ends with the old password.
    await endSessionsFor(userId, { keepSid: req.sessionID });

    // Update session encryption key
    if (result.encryptionKey) {
        req.session.encryptionKey = result.encryptionKey;
    }

    req.session.save((err) => {
        if (err) {
            log.error('Session save error:', err);
        }
        res.json({ success: true, message: 'Password changed successfully' });
    });
});

module.exports = router;
