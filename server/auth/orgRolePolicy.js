// @typecheck
/**
 * Per-organisation role → permission overrides.
 *
 * `config/orgRoles.json` ships the defaults, and until now it WAS the answer:
 * the mapping is install-wide, so an organisation could not decide that its
 * Members may not open Notebooks, or that only Agent Admins build Webpages.
 * The Roles screen said "ask an administrator to grant the Use Notebooks
 * permission" and there was no administrator anywhere who could.
 *
 * An override is stored per org under `org_role_permissions_<orgId>` as
 *   { "<role>": ["use_notebooks", "use_forms", …] }
 * and holds the org's FULL choice for that role out of EDITABLE_PERMISSIONS.
 * A role absent from the blob keeps the shipped default, so an org that never
 * touched the screen — and every new org — behaves exactly as before, and a
 * later default added to orgRoles.json still reaches them.
 *
 * ── What an org may and may not reshape ─────────────────────────────────────
 *
 * Only EDITABLE_PERMISSIONS: the "may this person USE this part of the
 * product" set. Everything else in a role — `manage_users`, the `admin_*`
 * pages, the role marker itself, n8n write access — is fixed by the shipped
 * config and cannot be granted or removed from here.
 *
 * That boundary is what makes the whole feature safe to expose to an org
 * admin without the "cannot assign permissions you don't have" ladder that
 * guards group roles (see the note in auth/admin/groupRoleRoutes.js). None of
 * these permissions can raise anyone's privileges over the organisation or its
 * tenants — the worst an admin can do is hand a colleague a feature their
 * licence already includes, or take one away, and both are their call.
 *
 * Deliberately NOT applied here: licence and beta gates. A granted
 * `use_webpages` in an org whose plan has no webpages still shows nothing —
 * the three gates are independent and stay that way (see the header of
 * agent-hub/src/components/admin/Studio/studioApps.jsx).
 */

const configStore = require('../stores/configStore');

/**
 * Registered in stores/user/organizations.js → orgConfigKeys so the row dies
 * with its organisation. organizations.configKeys.test.js fails until it is.
 */
const CONFIG_KEY_PREFIX = 'org_role_permissions_';

/**
 * The permissions an organisation may hand out or withdraw per role — one per
 * Studio section plus the three sidebar rows that are not Studio sections.
 * Ordered as the Roles screen renders them.
 */
const EDITABLE_PERMISSIONS = Object.freeze([
    'manage_agents',
    'manage_skills',
    'manage_knowledge',
    'use_meeting_notes',
    'use_automations',
    'use_datatables',
    'manage_datatables',
    'use_webpages',
    'manage_apps',
    'use_apps',
    'use_solutions',
    'use_approvals',
    'use_forms',
    'use_notebooks',
]);

const EDITABLE_SET = new Set(EDITABLE_PERMISSIONS);

/** @param {string} id @returns {boolean} */
function isEditablePermission(id) {
    return EDITABLE_SET.has(id);
}

// Read on the permission hot path (getUserPermissions, on its own cache miss),
// so memoised briefly. Writes invalidate explicitly rather than waiting it out.
const CACHE_TTL_MS = 30_000;
const _cache = new Map(); // orgId → { at, overrides }

function invalidateOrgRoleCache(orgId) {
    if (orgId === undefined) _cache.clear();
    else _cache.delete(String(orgId || ''));
}

/** Drop anything that is not an editable permission id. */
function sanitizePermissions(list) {
    if (!Array.isArray(list)) return [];
    const seen = new Set();
    for (const id of list) {
        if (typeof id === 'string' && EDITABLE_SET.has(id)) seen.add(id);
    }
    // Canonical order, so a stored blob does not depend on click order.
    return EDITABLE_PERMISSIONS.filter((id) => seen.has(id));
}

/**
 * The org's stored overrides, `{ role: string[] }`, or `{}` when it has never
 * changed anything. Never throws — an unreadable config row means "no
 * override", which is the shipped default, not an empty role.
 *
 * @param {string|null} orgId
 * @returns {Promise<Record<string, string[]>>}
 */
async function getOrgRoleOverrides(orgId) {
    const key = String(orgId || '');
    if (!key) return {};
    const hit = _cache.get(key);
    if (hit && Date.now() - hit.at <= CACHE_TTL_MS) return hit.overrides;

    /** @type {Record<string, string[]>} */
    let overrides = {};
    try {
        const stored = await configStore.getConfig(`${CONFIG_KEY_PREFIX}${key}`);
        if (stored && typeof stored === 'object' && !Array.isArray(stored)) {
            for (const [role, list] of Object.entries(stored)) {
                if (Array.isArray(list)) overrides[role] = sanitizePermissions(list);
            }
        }
    } catch (_) {
        overrides = {};
    }
    _cache.set(key, { at: Date.now(), overrides });
    return overrides;
}

/**
 * Apply one org's overrides to the shipped mapping.
 *
 * Pure, so the merge rule is testable on its own: for a role the org has an
 * opinion about, every EDITABLE permission is replaced by that opinion, and
 * everything else the default grants is kept untouched. For a role it has no
 * opinion about, the default stands.
 *
 * @param {Record<string, string[]>} defaults  from getOrgRolePermissions()
 * @param {Record<string, string[]>} overrides from getOrgRoleOverrides()
 * @returns {Record<string, string[]>}
 */
function mergeRolePermissions(defaults, overrides) {
    /** @type {Record<string, string[]>} */
    const out = {};
    for (const [role, perms] of Object.entries(defaults || {})) {
        const chosen = overrides && Object.prototype.hasOwnProperty.call(overrides, role)
            ? overrides[role]
            : null;
        if (!chosen) { out[role] = [...(perms || [])]; continue; }
        const fixed = (perms || []).filter((id) => !EDITABLE_SET.has(id));
        out[role] = [...fixed, ...sanitizePermissions(chosen)];
    }
    return out;
}

/**
 * The effective role → permission mapping for one organisation.
 *
 * @param {string|null} orgId
 * @param {Record<string, string[]>} defaults from getOrgRolePermissions()
 * @returns {Promise<Record<string, string[]>>}
 */
async function resolveOrgRolePermissions(orgId, defaults) {
    if (!orgId) return defaults || {};
    return mergeRolePermissions(defaults, await getOrgRoleOverrides(orgId));
}

/**
 * Store one role's editable permissions for an org.
 *
 * Writes the whole blob back rather than merging server-side per key, so the
 * stored value always reflects a complete, sanitised choice. Callers must
 * invalidate the PERMISSION cache afterwards — this module only owns its own.
 *
 * @param {string} orgId
 * @param {string} role
 * @param {string[]} permissions
 * @returns {Promise<string[]>} the sanitised list actually stored
 */
async function setOrgRolePermissions(orgId, role, permissions) {
    const key = `${CONFIG_KEY_PREFIX}${String(orgId)}`;
    const current = await getOrgRoleOverrides(orgId);
    const next = { ...current, [role]: sanitizePermissions(permissions) };
    await configStore.setConfig(key, next);
    invalidateOrgRoleCache(orgId);
    return next[role];
}

module.exports = {
    CONFIG_KEY_PREFIX,
    EDITABLE_PERMISSIONS,
    isEditablePermission,
    sanitizePermissions,
    mergeRolePermissions,
    getOrgRoleOverrides,
    resolveOrgRolePermissions,
    setOrgRolePermissions,
    invalidateOrgRoleCache,
};
