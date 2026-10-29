// @typecheck
const log = require('../../telemetry/log');
const userStore = require('../../stores/userStore');
const { isOrgAdminRole } = require('../permissions');
const { z, typeError } = require('../../utils/zod');
const { worded } = require('../../core/http/schemaParts');
const ORG_ROLE_DEFS = require('../../config/orgRoles.json');

/**
 * Envelope-encryption material that must never leave the server in a user list.
 *
 * Defence in depth: userStore.getAllUsers() does not SELECT these, so this is
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

/**
 * How much an orgRole can do, derived from its effective-permission count in
 * config/orgRoles.json so this ladder can never drift from the role model the
 * rest of the product enforces (a hard-coded ladder drifts as roles are added).
 *
 * Anything the role model does not define ranks 0, and that is the point: a
 * pentester set orgRole to 'owner' — a value that exists nowhere in this product
 * — and a ladder that scored unknown roles as 1 ("member") would treat stripping the
 * tenant's only administrator down to a role that grants NOTHING as a
 * sideways move and give no warning at all. An unrecognised role resolves to
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
    groups: z.array(worded('A group id must be text.'), { error: typeError({ invalid: 'groups must be a list of group ids.' }) }).optional(),
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
        log.warn('[adminRoutes] role allow-list lookup failed:', /** @type {Error} */ (e).message);
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

/**
 * The refusal for a user update that carries a field outside the allow-list,
 * or null. Refused, never silently dropped: a 200 for a privilege change that
 * did not happen is how a real escalation gets mistaken for a failed one.
 * @param {Record<string, unknown>} body
 * @returns {{ error: string, code: 'unknown_fields', fields: string[] } | null}
 */
function unknownFieldsRefusal(body) {
    const unknownFields = Object.keys(body).filter(k => !USER_UPDATE_ALLOWED_KEYS.has(k));
    if (unknownFields.length === 0) return null;
    return {
        error: `Unsupported field(s): ${unknownFields.join(', ')}`,
        code: 'unknown_fields',
        fields: unknownFields,
    };
}

/**
 * The access-relevant changes of a user update, for the audit row: role,
 * orgRole, groups, organizationId and status, each only when it is written
 * and differs from what the user had — never password material.
 * @param {Record<string, unknown> | null} prevUser  the user before the update
 * @param {Record<string, unknown>} updates
 */
function accessChanges(prevUser, updates) {
    const ACCESS_FIELDS = ['role', 'orgRole', 'groups', 'organizationId', 'status'];
    /** @type {Record<string, unknown>} */
    const oldVals = {};
    /** @type {Record<string, unknown>} */
    const newVals = {};
    for (const f of ACCESS_FIELDS) {
        if (updates[f] === undefined) continue;
        if (prevUser && JSON.stringify(prevUser[f]) === JSON.stringify(updates[f])) continue;
        oldVals[f] = prevUser ? prevUser[f] : null;
        newVals[f] = updates[f];
    }
    return { oldVals, newVals };
}

module.exports = { stripKeyMaterial, buildRoleDowngradeHint, CreateUserBody, ChangePasswordBody, USER_UPDATE_FIELDS, SUPER_ADMIN_ONLY_FIELDS, isKnownRoleId, USER_UPDATE_ALLOWED_KEYS, USER_TEXT_FIELDS, needsAdminPasswordFloor, unknownFieldsRefusal, accessChanges };
