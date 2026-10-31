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
const { stripKeyMaterial, buildRoleDowngradeHint, CreateUserBody, ChangePasswordBody, USER_UPDATE_FIELDS, SUPER_ADMIN_ONLY_FIELDS, isKnownRoleId, USER_TEXT_FIELDS, needsAdminPasswordFloor, unknownFieldsRefusal, accessChanges, endSessionsFor } = require('./userSupportRoutes');
const router = express.Router();

const userStore = require('../../stores/userStore');
const { loadConfig, requireAuth, getUserPermissions, invalidatePermissionCache, resolveUserOrgIds, isOrgAdminRole } = require('../permissions');
const { rewrapUserDEKCompat, adminResetUser } = require('../encryption');
// One password policy for every write path. Without it /change-password would
// accept 4 characters and the admin create / update paths would hash whatever
// they were handed — so an account provisioned or "reset" through the admin
// panel could carry a one-character password while signup and password-reset
// enforce 8.
const { validatePassword } = require('../passwordPolicy');
const { sanitizePlainTextFields } = require('../../utils/htmlSanitizer');
const { checkResourceLimits } = require('../../core/entitlements/limits');
const { validate } = require('../../core/http/validate');
const {
    isActiveUserStatus,
    wouldOrphanOrg,
    orgsAdministeredBy,
    repairIfOrphaned,
    refuseLastOrgAdmin,
    normaliseOrgId,
    requireOrgAdminForUser,
} = require('./orgAdminGuards');

// The org-role model, read from the same file permissions.js resolves against.

/**
 * The exact fields PUT /users/:id writes. This is the single source for both
 * the `updates` object the handler builds AND the unknown-key rejection in
 * front of it, so the two can never drift into the state the pentest found:
 * a body field accepted, answered with 200 {"success":true}, and then dropped.
 */

// === User Management API (Admin Only) ===

// Get all users — requires manage_users, admin_security, or org_admin
router.get('/users', requireAuth, async (req, res) => {
    // Non-super-admins must have user management permissions
    const isSuperAdmin = req.session.isAdmin || req.session.user?.role === 'admin';
    if (!isSuperAdmin) {
        const userId = req.session.user?.id;
        const perms = await getUserPermissions(userId, req.session);
        const canView = perms.includes('all') || perms.includes('manage_users') || perms.includes('admin_security') || perms.includes('org_admin');
        if (!canView) {
            return res.status(403).json({ error: 'Permission required to view users' });
        }
    }

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

    // Merge default groups from all organizations
    let finalGroups = groups || [];
    try {
        const orgs = await userStore.getAllOrganizations();
        for (const org of orgs) {
            if (org.defaultGroups && Array.isArray(org.defaultGroups)) {
                for (const gid of org.defaultGroups) {
                    if (!finalGroups.includes(gid)) {
                        finalGroups.push(gid);
                    }
                }
            }
        }
    } catch (e) {
        log.warn('[Auth] Failed to merge default groups:', /** @type {Error} */ (e).message);
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

// Update user
router.put('/users/:id', requireOrgAdminForUser, async (req, res) => {
    const { id } = req.params;
    const body = req.body || {};

    // Anything outside the allow-list is refused instead of silently dropped.
    // A pentester sent {"isAdmin":true} here and got 200 {"success":true} while
    // the flag went nowhere: the handler only ever copied a fixed field list.
    // No escalation happened — but a report of "success" for a privilege change
    // that did not happen is exactly how a real escalation gets mistaken for a
    // failed one, and a failed one for a real escalation. Sibling refusals in
    // this file (role='admin' → 403 'Cannot assign super admin role') already
    // name what they reject; this does the same.
    const unknownFields = unknownFieldsRefusal(body);
    if (unknownFields) return res.status(400).json(unknownFields);

    // Everything else is read through `updates` below, which is built from
    // USER_UPDATE_FIELDS so it cannot fall out of step with the allow-list.
    const { role, password, oldPassword, confirmSelfDemotion } = body;

    if (isPlatformOperator(id)) {
        if (role && role !== 'admin') {
            return res.status(400).json({ error: 'Cannot downgrade system admin' });
        }
    }

    // The value, not just the field. `role` was guarded by a denylist of one
    // exact string, so `super_admin` and `root` were stored happily — and the
    // error message on the one refusal ("Cannot assign super admin role") named
    // the very value that succeeded. An allow-list of roles this installation
    // actually defines removes the whole class, for super admins too: a role
    // that resolves to nothing is a corrupted record, not an assignment.
    if (role !== undefined && !(await isKnownRoleId(role))) {
        return res.status(400).json({
            error: `Unknown role: ${String(role).slice(0, 64)}`,
            code: 'unknown_role',
        });
    }

    // Snapshot the user's access-relevant fields before mutation so the
    // audit row captures the actual transition rather than just the new
    // state. Failures here are non-fatal — auditing must not block the
    // update.
    let prevUser = null;
    try { prevUser = await userStore.getUser(id); } catch (_) { prevUser = null; }

    const updates = sanitizePlainTextFields(
        Object.fromEntries(USER_UPDATE_FIELDS.map(f => [f, body[f]])),
        USER_TEXT_FIELDS,
    );

    // Tenant membership is super-admin-only (see SUPER_ADMIN_ONLY_FIELDS). For
    // anyone else the key is dropped rather than refused here — the middleware
    // has already 403'd an actual CHANGE, so what reaches this point is the users
    // panel echoing the row back unchanged, and failing that would break every
    // ordinary org-admin save.
    const isSuperAdmin = req.session?.isAdmin || req.session?.user?.role === 'admin';
    if (isSuperAdmin) {
        for (const field of SUPER_ADMIN_ONLY_FIELDS) updates[field] = body[field];

        // A relocated user keeps no standing from the tenant they left: org_admin
        // in the old org says nothing about the new one, and carrying it across is
        // what turned the reported tenant hop into a tenant takeover. An explicit
        // orgRole in the same request still wins — the operator may say what the
        // user should be on arrival.
        const movingOrg = updates.organizationId !== undefined
            && normaliseOrgId(updates.organizationId) !== normaliseOrgId(prevUser?.organizationId);
        if (movingOrg && body.orgRole === undefined) {
            updates.orgRole = normaliseOrgId(updates.organizationId) === null ? '' : 'member';
        }
    }

    // ── Sole-org-admin protection (see countOtherOrgAdmins) ──
    // Three of the writable fields can take an administrator off an
    // organisation's roster, and all three had to be closed together: demote the
    // orgRole, move them to another org, or park them in a non-active status.
    // The platform `role` is deliberately not one of them — that is super-admin,
    // a platform axis, and it has no bearing on who can administer a tenant.
    /** @type {string[]} */
    let guardedOrgIds = [];
    if (prevUser && isOrgAdminRole(prevUser.orgRole)) {
        const orgId = prevUser.organizationId;
        const losesRole = updates.orgRole !== undefined && !isOrgAdminRole(updates.orgRole);
        const losesOrg = updates.organizationId !== undefined && updates.organizationId !== orgId;
        const losesActive = updates.status !== undefined && !isActiveUserStatus(updates.status);

        if (losesRole || losesOrg || losesActive) {
            // Every org this user administers, not just their primary one —
            // see orgsAdministeredBy for why those differ.
            guardedOrgIds = await orgsAdministeredBy(prevUser);
            for (const guardedOrg of guardedOrgIds) {
                if (await wouldOrphanOrg(guardedOrg, id)) {
                    return refuseLastOrgAdmin(res, 'That change');
                }
            }
        }

        // Self-demotion is allowed — an admin may hand the org over and step
        // down — but never as a side effect of a click. The SPA PUTs the whole
        // user row back, so a mis-set role dropdown could strip the caller's own
        // administration rights in one request with nothing to confirm. The
        // opt-in makes the client say it meant it, and the 409 carries the same
        // `hint` payload the success response would have, so the panel can drive
        // its confirm dialog straight off this response.
        if (losesRole && id && id === req.session?.user?.id && confirmSelfDemotion !== true) {
            const hint = buildRoleDowngradeHint(prevUser.orgRole, updates.orgRole);
            return res.status(409).json({
                error: 'This would remove your own administrator rights over this organisation. Re-send with confirmSelfDemotion: true to proceed.',
                code: 'confirm_self_demotion',
                ...(hint ? { hint } : {}),
            });
        }
    }

    if (password) {
        // Same policy as signup and password reset. Both branches below hashed
        // whatever arrived, so an "admin reset" was a way to put a
        // one-character password on someone else's account. The e-mail/username
        // context lets the validator reject passwords derived from the account
        // itself, and the target's post-update reach decides which minimum
        // length applies.
        const pwCheck = validatePassword(password, {
            username: prevUser?.username || id,
            email: updates.email ?? prevUser?.email,
            isAdmin: needsAdminPasswordFloor({
                role: updates.role ?? prevUser?.role,
                orgRole: updates.orgRole ?? prevUser?.orgRole,
            }),
        });
        if (!pwCheck.ok) {
            return res.status(400).json({ error: pwCheck.error, ...(pwCheck.code ? { code: pwCheck.code } : {}) });
        }

        updates.passwordHash = await passwords.hash(password);

        if (oldPassword) {
            // User-initiated password change — rewrap DEK
            try {
                const result = await rewrapUserDEKCompat(id, oldPassword, password);
                if (!result.success) {
                    return res.status(400).json({ error: 'Failed to verify old password' });
                }
            } catch (err) {
                log.error('[Auth] DEK rewrap failed:', /** @type {Error} */ (err).message);
                return res.status(400).json({ error: 'Failed to verify old password' });
            }
        } else {
            // Admin-initiated password reset — destructive (zero-knowledge)
            await adminResetUser(id);
            log.warn(`[Auth] Admin reset user ${id} — encrypted data requires recovery key`);
        }
    }

    if (await userStore.updateUser(id, updates)) {
        // The pre-check is a read; this is the write. Two admins demoting each
        // other in parallel both pass the read. See repairIfOrphaned.
        if (guardedOrgIds.length) {
            const orphaned = await repairIfOrphaned(guardedOrgIds, prevUser);
            if (orphaned) return refuseLastOrgAdmin(res, 'That change');
        }

        // A non-active status or a new password ends the account's sessions (the person changing their own keeps this one).
        const becomesInactive = updates.status !== undefined && !isActiveUserStatus(updates.status);
        if (becomesInactive || password) await endSessionsFor(id, id === req.session?.user?.id && !becomesInactive ? { keepSid: req.sessionID } : {});

        const changedFields = Object.keys(updates).filter(k => updates[k] !== undefined);
        log.info(`[Audit] ${req.session.user?.id || 'system'} updated user '${id}' — fields: ${changedFields.join(', ')}`);
        // Capture only the access-relevant changes for audit (role, orgRole,
        // groups, organizationId, status) — never log password material.
        const { oldVals, newVals } = accessChanges(prevUser, updates);
        if (Object.keys(newVals).length > 0) {
            await userStore.logAccessAudit(
                'user.update',
                'user',
                id,
                req.session.user?.id || null,
                oldVals,
                newVals,
                (prevUser && prevUser.organizationId) || updates.organizationId || null,
            );
        }
        // Role / orgRole / group changes alter the user's effective permissions.
        await invalidatePermissionCache(id);
        // Bust the requireAuth user-existence cache so a role demotion takes
        // effect on the very next request instead of waiting USER_CHECK_TTL.
        try { await require('../permissions').invalidateUserExistenceCache(id); } catch (err) { bestEffort('auth/admin/users:invalidateExistenceCache', err); }

        // Soft hint when the admin is assigning a *weaker* orgRole than the
        // user already had. Not an error — admins legitimately demote — but
        // the UI can show a confirm prompt before applying. The ranks come
        // from orgRoles.json's effective-permission count (more permissions
        // = "higher"), via orgRoleRank().
        const hint = updates.orgRole !== undefined
            ? buildRoleDowngradeHint(prevUser?.orgRole, updates.orgRole)
            : null;
        res.json({ success: true, ...(hint ? { hint } : {}) });
    } else {
        res.status(404).json({ error: 'User not found' });
    }
});

// Reset a user's two-factor authentication. Org admins over their
// own members (enforced by requireOrgAdminForUser) or super-admins. Clears
// enrollment entirely; because `require_mfa_for_password_accounts` defaults
// on, the user is forced to re-enroll at their next login — so this unlocks a
// locked-out user without weakening the account long-term. Audited.
router.post('/users/:id/mfa/reset', requireOrgAdminForUser, async (req, res) => {
    const { id } = req.params;
    const target = await userStore.getUser(id);
    if (!target) return res.status(404).json({ error: 'User not found' });
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

    // Deleting the last org_admin orphans the tenant just as thoroughly as
    // demoting them, and irreversibly — the row is gone. Same guard, same rule:
    // it fires only when the organisation still has OTHER members to strand, so
    // the sole member of a one-person org (every self-serve org signup starts as
    // exactly that) remains deletable. Erasure has to keep working on a privacy
    // product; this route is the only path to it.
    if (prevUser && isOrgAdminRole(prevUser.orgRole)) {
        for (const guardedOrg of await orgsAdministeredBy(prevUser)) {
            if (await wouldOrphanOrg(guardedOrg, id)) {
                return refuseLastOrgAdmin(res, 'Deleting this user');
            }
        }
    }

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
