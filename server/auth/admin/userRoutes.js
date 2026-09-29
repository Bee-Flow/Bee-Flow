// @typecheck
/**
 * Admin Routes — user management: list/create/update/delete, MFA reset,
 * avatars and the self-service password change. Split out of
 * auth/adminRoutes.js; mounted there first, in the original registration order.
 */

const express = require('express');
const bcrypt = require('bcryptjs');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const log = require('../../telemetry/log');
const router = express.Router();

const userStore = require('../../stores/userStore');
const { loadConfig, requireAuth, getUserPermissions, invalidatePermissionCache, resolveUserOrgIds, isOrgAdminRole } = require('../permissions');
const { rewrapUserDEKCompat, adminResetUser } = require('../encryption');
// One password policy for every write path. These routes used to be the soft
// underbelly: /change-password accepted 4 characters, and the admin create /
// update paths hashed whatever they were handed with no check at all — so an
// account provisioned or "reset" through the admin panel could carry a
// one-character password while signup and password-reset enforced 8.
const { validatePassword } = require('../passwordPolicy');
const { sanitizePlainTextFields } = require('../../utils/htmlSanitizer');
const { checkResourceLimits } = require('../../core/entitlements/limits');
const { validate } = require('../../core/http/validate');
const { z } = require('zod');
const {
    isActiveUserStatus,
    wouldOrphanOrg,
    orgsAdministeredBy,
    repairIfOrphaned,
    refuseLastOrgAdmin,
    normaliseOrgId,
    requireOrgAdminForUser,
} = require('./orgAdminGuards');

/**
 * Envelope-encryption material that must never leave the server in a user list.
 *
 * Defence in depth: userStore.getAllUsers() no longer SELECTs these, so this is
 * belt to that braces. It matters because the user-list routes below serialise
 * whatever the store hands back — a widened SELECT, a new column, or a different
 * store function would silently put wrapped DEKs and KDF salts back on the wire,
 * where any org_admin could collect them and attack a member's password offline.
 * Keep this list in sync with the comment on getAllUsers (stores/user/users.js).
 */
const USER_KEY_MATERIAL = ['masterWrappedDEK', 'wrappedDEK', 'kekSalt', 'recoverySalt', 'recoveryWrappedDEK'];

function stripKeyMaterial(user) {
    const safe = { ...user };
    for (const field of USER_KEY_MATERIAL) delete safe[field];
    return safe;
}

// The org-role model, read from the same file permissions.js resolves against.
const ORG_ROLE_DEFS = require('../../config/orgRoles.json');

/**
 * How much an orgRole can do, derived from its effective-permission count in
 * config/orgRoles.json so this ladder can never drift from the role model the
 * rest of the product enforces (the hard-coded ladder that used to live in the
 * PUT handler had already lost `isms_auditor`).
 *
 * Anything the role model does not define ranks 0, and that is the point: a
 * pentester set orgRole to 'owner' — a value that exists nowhere in this product
 * — and the old ladder scored unknown roles as 1 ("member"), so stripping the
 * tenant's only administrator down to a role that grants NOTHING looked like a
 * sideways move and produced no warning at all. An unrecognised role resolves to
 * zero permissions at runtime, so moving to one is always a downgrade.
 */
function orgRoleRank(orgRole) {
    const key = isOrgAdminRole(orgRole) ? 'org_admin' : String(orgRole || '');
    const def = ORG_ROLE_DEFS[key];
    return Array.isArray(def?.permissions) ? def.permissions.length : 0;
}

/**
 * The soft warning the users panel shows before applying a weaker orgRole.
 * Shared by the confirm-required 409 and the success response so the SPA sees
 * one payload shape either way.
 */
function buildRoleDowngradeHint(fromRole, toRole) {
    if (!fromRole || toRole === undefined || toRole === fromRole) return null;
    if (orgRoleRank(toRole) >= orgRoleRank(fromRole)) return null;
    return {
        kind: 'role_downgrade',
        from: fromRole,
        to: toRole,
        message: `Note: '${toRole || 'no role'}' has fewer permissions than '${fromRole}'. The user will lose access to some features immediately.`,
    };
}

/**
 * The exact fields PUT /users/:id writes. This is the single source for both
 * the `updates` object the handler builds AND the unknown-key rejection in
 * front of it, so the two can never drift into the state the pentest found:
 * a body field accepted, answered with 200 {"success":true}, and then dropped.
 */

/** A string whose every refusal — including "you left it out" — is a sentence. */
const worded = (message) => z.string({ required_error: message, invalid_type_error: message });

const CREATE_TEXT = 'Username and password required';
const CHANGE_TEXT = 'Old and new password required';

/**
 * POST /users. The UPDATE route below has refused unknown keys since a pentest
 * sent {"isAdmin":true} and got 200 {"success":true} with the flag going
 * nowhere; CREATE was the same handler shape and never grew the guard, so the
 * identical body made an account and reported success for a privilege that was
 * never granted. `role` and `orgRole` keep their existing value checks in the
 * handler — they are installation-defined (isKnownRoleId, orgRoles.json), so a
 * list frozen at module load would refuse a role a deployment legitimately has.
 */
const CreateUserBody = z.object({
    username: worded(CREATE_TEXT).min(1, CREATE_TEXT).max(200, 'That username is too long.'),
    password: worded(CREATE_TEXT).min(1, CREATE_TEXT),
    displayName: worded('A display name must be text.').max(400, 'That display name is too long.').optional(),
    firstName: worded('A first name must be text.').max(200, 'That first name is too long.').optional(),
    lastName: worded('A last name must be text.').max(200, 'That last name is too long.').optional(),
    email: worded('An e-mail address must be text.').trim().max(254, 'That e-mail address is too long.').optional(),
    phone: worded('A phone number must be text.').max(64, 'That phone number is too long.').optional(),
    avatar: worded('An avatar must be text.').max(2_000_000, 'That avatar image is too large.').nullable().optional(),
    avatarType: worded('An avatar type must be text.').max(32, 'That avatar type is too long.').nullable().optional(),
    role: worded('A role must be text.').max(64, 'That role name is too long.').optional(),
    groups: z.array(worded('A group id must be text.'), { invalid_type_error: 'groups must be a list of group ids.' }).optional(),
    orgRole: worded('An organisation role must be text.').max(64, 'That organisation role is too long.').optional(),
    organizationId: worded('An organization id must be text.').trim().max(200, 'That organization id is too long.').optional(),
}).strict();

const ChangePasswordBody = z.object({
    oldPassword: worded(CHANGE_TEXT).min(1, CHANGE_TEXT),
    newPassword: worded(CHANGE_TEXT).min(1, CHANGE_TEXT),
}).strict();

const USER_UPDATE_FIELDS = Object.freeze([
    'groups', 'displayName', 'firstName', 'lastName', 'email', 'phone',
    'avatar', 'avatarType', 'orgRole', 'status',
]);

/**
 * Writable ONLY by a platform super-admin.
 *
 * `organizationId` is tenant membership itself — the property the whole product
 * rests on — so it does not belong in the list above, which any org admin can
 * drive.
 *
 * `role` is here because it is a PLATFORM axis, and because the guard on it was
 * a denylist of one exact string: `{"role":"admin"}` was refused while
 * `super_admin`, `root`, `Admin` and `" admin"` were all accepted and stored. A
 * pentest reported that as harmless on the grounds that authorization reads
 * `isAdmin` and `orgRole` rather than `role`. That is true of the values it
 * tried, and false in general: permissions.js resolves `users.role` as a KEY
 * into the roles table ("Resolve the user's direct role field") and unions in
 * whatever that row grants. A role carrying `all` short-circuits
 * getUserPermissions to ['all'], which clears requireAdmin and every
 * requirePermission gate in the product. The tested values granted nothing only
 * because they miss the map — a value that hits it does not.
 *
 * Making it super-admin-only costs nothing: the admin UI has no role picker, it
 * seeds 'user' and echoes the stored value back untouched, and the only writer
 * of 'admin' anywhere is boot-init.js.
 *
 * Both fields follow the same rule — an unchanged value echoed back by the panel
 * is ignored, a changed one is refused — and both are enforced twice: named 403s
 * in the middleware, and this list, so a future route that forgets the
 * middleware still cannot write them.
 */
const SUPER_ADMIN_ONLY_FIELDS = Object.freeze(['organizationId', 'role']);

/**
 * Platform roles the product itself writes. `SystemRoles` is the authority;
 * this mirrors it so the allowlist has a stable floor even if the roles table is
 * empty or unreachable.
 */
const BUILTIN_ROLE_IDS = Object.freeze(['admin', 'user']);

/**
 * Is `value` a role this installation actually defines?
 *
 * The allowlist is the union of the built-in platform roles and the ids in the
 * roles table — deliberately the exact key space permissions.js consults, so it
 * can never reject a value that would have resolved to real permissions, and
 * never accept one that would silently resolve to nothing.
 */
async function isKnownRoleId(value) {
    const v = String(value ?? '');
    if (BUILTIN_ROLE_IDS.includes(v)) return true;
    try {
        const roles = await userStore.getAllRoles();
        return (roles || []).some(r => r?.id === v);
    } catch (e) {
        // Fail closed: an unverifiable role is not a role.
        log.warn('[adminRoutes] role allow-list lookup failed:', e.message);
        return false;
    }
}

/**
 * Accepted by PUT /users/:id but not written straight through:
 *   • password / oldPassword — drive the hash and the DEK rewrap.
 *   • confirmSelfDemotion    — the explicit opt-in for demoting yourself.
 *   • id / username          — the users panel PUTs the whole row back, so these
 *     arrive as echoes of an identity that comes from the :id path param.
 *     Ignoring them is deliberate (a body may not rename or re-target a user);
 *     rejecting them would break that panel for no security gain.
 */
const USER_UPDATE_CONTROL_FIELDS = Object.freeze([
    'password', 'oldPassword', 'confirmSelfDemotion', 'id', 'username',
]);

const USER_UPDATE_ALLOWED_KEYS = new Set([
    ...USER_UPDATE_FIELDS, ...SUPER_ADMIN_ONLY_FIELDS, ...USER_UPDATE_CONTROL_FIELDS,
]);

/** User-facing profile text — same reasoning, same sinks (invitation mail). */
const USER_TEXT_FIELDS = Object.freeze([
    'displayName', 'firstName', 'lastName', 'email', 'phone',
]);

/**
 * Does this account carry administrative reach — platform operator, or the
 * administrator of its own organisation? The password policy is the only caller:
 * an admin credential unlocks a whole tenant, so it gets the longer minimum.
 *
 * Deliberately a module-level helper rather than an inline check: this is a
 * property of a user ROW, never an authorization decision, and auth/routeWalk
 * reads route-handler bodies for gate-shaped calls (`isOrgAdmin…`) to find rules
 * hiding outside the middleware chain. Keeping it out here keeps that signal
 * honest instead of teaching the drift test to ignore a real pattern. Do not
 * grow this into a gate.
 */
function needsAdminPasswordFloor(u) {
    return u?.role === 'admin' || isOrgAdminRole(u?.orgRole);
}

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

    let allUsers = [superAdmin, ...users.filter(u => u.id !== 'admin')];

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
            try { uGroups = Array.isArray(u.groups) ? u.groups : JSON.parse(u.groups || '[]'); } catch (_) { }
            return uGroups.some(gid => orgGroupIds.has(gid));
        });
    }

    res.json(allUsers.map(stripKeyMaterial));
});

// Create user
router.post('/users', requireOrgAdminForUser, validate({ body: CreateUserBody }), async (req, res) => {
    const { username, displayName, firstName, lastName, email, phone, avatar, avatarType, password, role, groups, orgRole, organizationId } = req.body;

    if (username === 'admin') {
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
        log.warn('[Auth] Failed to merge default groups:', e.message);
    }

    const passwordHash = await bcrypt.hash(password, 10);
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
            log.info(`[Audit] ${req.session.user?.id || 'system'} created user '${username}' in org '${organizationId || 'none'}' with orgRole '${orgRole || 'none'}'`);
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
        log.error('[adminRoutes] createUser error:', e);
        return res.status(500).json({ error: 'Failed to create user' });
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
    const unknownFields = Object.keys(body).filter(k => !USER_UPDATE_ALLOWED_KEYS.has(k));
    if (unknownFields.length > 0) {
        return res.status(400).json({
            error: `Unsupported field(s): ${unknownFields.join(', ')}`,
            code: 'unknown_fields',
            fields: unknownFields,
        });
    }

    // Everything else is read through `updates` below, which is built from
    // USER_UPDATE_FIELDS so it cannot fall out of step with the allow-list.
    const { role, password, oldPassword, confirmSelfDemotion } = body;

    if (id === 'admin') {
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

        updates.passwordHash = await bcrypt.hash(password, 10);

        if (oldPassword) {
            // User-initiated password change — rewrap DEK
            try {
                const result = await rewrapUserDEKCompat(id, oldPassword, password);
                if (!result.success) {
                    return res.status(400).json({ error: 'Failed to verify old password' });
                }
            } catch (err) {
                log.error('[Auth] DEK rewrap failed:', err.message);
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

        const changedFields = Object.keys(updates).filter(k => updates[k] !== undefined);
        log.info(`[Audit] ${req.session.user?.id || 'system'} updated user '${id}' — fields: ${changedFields.join(', ')}`);
        // Capture only the access-relevant changes for audit (role, orgRole,
        // groups, organizationId, status) — never log password material.
        const ACCESS_FIELDS = ['role', 'orgRole', 'groups', 'organizationId', 'status'];
        const oldVals = {};
        const newVals = {};
        for (const f of ACCESS_FIELDS) {
            if (updates[f] === undefined) continue;
            if (prevUser && JSON.stringify(prevUser[f]) === JSON.stringify(updates[f])) continue;
            oldVals[f] = prevUser ? prevUser[f] : null;
            newVals[f] = updates[f];
        }
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
        try {
            const { invalidateUserExistenceCache } = require('../permissions');
            await invalidateUserExistenceCache(id);
        } catch (_) { /* optional helper */ }

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

// Reset a user's two-factor authentication (BFSF-274). Org admins over their
// own members (enforced by requireOrgAdminForUser) or super-admins. Clears
// enrollment entirely; because `require_mfa_for_password_accounts` defaults
// on, the user is forced to re-enroll at their next login — so this unlocks a
// locked-out user without weakening the account long-term. Audited.
router.post('/users/:id/mfa/reset', requireOrgAdminForUser, async (req, res) => {
    const { id } = req.params;
    try {
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
        if (!ok) return res.status(500).json({ error: 'Failed to reset MFA' });

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
    } catch (e) {
        log.error('[adminRoutes] mfa reset error:', e);
        res.status(500).json({ error: 'Failed to reset MFA' });
    }
});

// Delete user
router.delete('/users/:id', requireOrgAdminForUser, async (req, res) => {
    const { id } = req.params;
    if (id === 'admin') {
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
            const { bustSessionsForUser } = require('../sessionCache');
            await bustSessionsForUser(id);
        } catch (_) { /* optional */ }
        res.json({ success: true });
    } else {
        res.status(404).json({ error: 'User not found' });
    }
});

// Upload user avatar image
const userAvatarUpload = multer({
    storage: multer.diskStorage({
        destination: (req, file, cb) => {
            const uploadDir = path.join(__dirname, '..', '..', 'data', 'uploads');
            if (!fs.existsSync(uploadDir)) {
                fs.mkdirSync(uploadDir, { recursive: true });
            }
            cb(null, uploadDir);
        },
        filename: (req, file, cb) => {
            const ext = path.extname(file.originalname);
            cb(null, `user-avatar-${req.params.id}-${Date.now()}${ext}`);
        }
    }),
    limits: { fileSize: 2 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        if (/^image\/(png|jpeg|jpg|svg\+xml|webp|gif)$/.test(file.mimetype)) {
            cb(null, true);
        } else {
            cb(new Error('Only PNG, JPG, SVG, WEBP, GIF images are allowed'));
        }
    }
});

router.post('/users/:id/avatar', requireOrgAdminForUser, userAvatarUpload.single('avatar'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const avatarPath = `/uploads/${req.file.filename}`;
    await userStore.updateUser(req.params.id, { avatar: avatarPath, avatarType: 'image' });
    res.json({ success: true, avatar: avatarPath, avatarType: 'image' });
});

router.delete('/users/:id/avatar', requireOrgAdminForUser, async (req, res) => {
    const user = await userStore.getUser(req.params.id);
    if (user && user.avatar && user.avatarType === 'image') {
        const filePath = path.join(__dirname, '..', '..', 'data', user.avatar);
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

    const isValid = await bcrypt.compare(oldPassword, user.passwordHash);
    if (!isValid) {
        return res.status(401).json({ error: 'Current password is incorrect' });
    }

    try {
        const result = await rewrapUserDEKCompat(userId, oldPassword, newPassword);
        if (!result.success) {
            return res.status(500).json({ error: 'Failed to update encryption keys' });
        }

        const passwordHash = await bcrypt.hash(newPassword, 10);
        await userStore.updateUser(userId, { passwordHash });

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
    } catch (err) {
        log.error('[Auth] Password change DEK operation failed:', err.message);
        return res.status(500).json({ error: 'Failed to update encryption keys' });
    }
});

module.exports = router;
