// @typecheck
/**
 * The organisation-wide MCP access policy.
 *
 *   {
 *     enabled: true,
 *     ipAllowlist: ["203.0.113.0/24", "2001:db8::/32"],
 *     allowedUsers: { mode: "all" | "roles" | "users", roles: [], userIds: [] },
 *     rejectLegacyTokens: false
 *   }
 *
 * Stored as an encrypted config value under `org_<orgId>_mcp_access`, so it is
 * bound to the organisation's key and removed with the organisation (the
 * `org_<orgId>_%` sweep in stores/user/organizations.js). A missing document is
 * the default below, which equals today's behaviour: nothing changes on upgrade.
 */

'use strict';

const { z } = require('zod');
const { badRequest } = require('../../shared/httpErrors');
const { parseCidrList } = require('./ipMatch');
const log = require('../../telemetry/log');

const MAX_LIST = 500;

const DEFAULT_POLICY = Object.freeze({
    enabled: true,
    ipAllowlist: Object.freeze([]),
    allowedUsers: Object.freeze({ mode: 'all', roles: Object.freeze([]), userIds: Object.freeze([]) }),
    rejectLegacyTokens: false,
});

/** Collaborators, loaded on first use; tests swap them through setDeps. */
let overrides = {};
const deps = {
    get configStore() { return overrides.configStore || require('../../stores/configStore'); },
    get userStore() { return overrides.userStore || require('../../stores/userStore'); },
};
function setDeps(next = {}) { overrides = { ...next }; }

const storageKey = (orgId) => `org_${orgId}_mcp_access`;

const idList = (what) => z.array(z.string().trim().min(1).max(200), {
    invalid_type_error: `${what} must be a list.`,
}).max(MAX_LIST, `${what} can hold at most ${MAX_LIST} entries.`);

/** The request / storage shape. Unknown keys are refused, so a typo is not silently dropped. */
const PolicySchema = z.object({
    enabled: z.boolean({ invalid_type_error: '"enabled" must be true or false.' }).default(true),
    ipAllowlist: z.array(z.string(), { invalid_type_error: 'The IP allow-list must be a list.' }).default([]).transform((list, ctx) => {
        try {
            return parseCidrList(list);
        } catch (err) {
            ctx.addIssue({ code: z.ZodIssueCode.custom, message: err.message });
            return z.NEVER;
        }
    }),
    allowedUsers: z.object({
        mode: z.enum(['all', 'roles', 'users'], { errorMap: () => ({ message: 'Choose "all", "roles" or "users" for who may use MCP.' }) }).default('all'),
        roles: idList('The role list').default([]),
        userIds: idList('The user list').default([]),
    }).strict('Send only mode, roles and userIds under allowedUsers.').default({}),
    rejectLegacyTokens: z.boolean({ invalid_type_error: '"rejectLegacyTokens" must be true or false.' }).default(false),
}).strict('Send only enabled, ipAllowlist, allowedUsers and rejectLegacyTokens.');

/**
 * Validate a policy document and return its canonical form.
 * @throws {import('../../shared/httpErrors').HttpError} 400
 */
function normalizePolicy(input) {
    const parsed = PolicySchema.safeParse(input);
    if (!parsed.success) {
        const issue = parsed.error.issues[0];
        throw badRequest('invalid_policy', issue?.message || 'The MCP access policy is not valid.');
    }
    const policy = parsed.data;
    if (policy.allowedUsers.mode === 'roles' && policy.allowedUsers.roles.length === 0) {
        throw badRequest('invalid_policy', 'Choose at least one role, or allow all users.');
    }
    if (policy.allowedUsers.mode === 'users' && policy.allowedUsers.userIds.length === 0) {
        throw badRequest('invalid_policy', 'Choose at least one user, or allow all users.');
    }
    return policy;
}

/**
 * The org's policy, or the default. A stored document that cannot be read or
 * parsed THROWS rather than falling back to the open default: a policy that
 * fails to load must not silently lift an IP restriction.
 */
async function getOrgMcpPolicy(orgId) {
    if (!orgId) return structuredClone(DEFAULT_POLICY);
    const raw = await deps.configStore.getSecret(storageKey(orgId));
    if (!raw) return structuredClone(DEFAULT_POLICY);
    let doc;
    try {
        doc = typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch (err) {
        log.error(`[McpAccess] stored policy for org ${orgId} is not valid JSON: ${err.message}`);
        throw new Error('The stored MCP access policy could not be read.');
    }
    // The stored document was normalised on write; this only fills in fields a
    // later version adds. It never accepts what the schema would refuse.
    const parsed = PolicySchema.safeParse(doc);
    if (!parsed.success) {
        log.error(`[McpAccess] stored policy for org ${orgId} failed validation: ${parsed.error.issues[0]?.message}`);
        throw new Error('The stored MCP access policy could not be read.');
    }
    return parsed.data;
}

/**
 * Validate, store and audit a new policy. Returns the saved policy.
 * @throws {import('../../shared/httpErrors').HttpError} 400
 */
async function saveOrgMcpPolicy(orgId, policy, actorId) {
    if (!orgId) throw badRequest('no_organization', 'This account has no organisation to set a policy for.');
    const next = normalizePolicy(policy);
    const before = await getOrgMcpPolicy(orgId).catch(() => null);
    await deps.configStore.setSecret(storageKey(orgId), JSON.stringify(next), {
        orgId, userId: actorId || null, integration: 'mcp_access',
    });
    // access_audit_log carries the organisation and logAccessAudit never throws.
    await deps.userStore.logAccessAudit('mcp.policy.update', 'organization', orgId, actorId || 'system', before, next, orgId);
    return next;
}

/** Does `policy.allowedUsers` admit this user? (Pure.) */
function userAllowedByPolicy(policy, user) {
    const mode = policy?.allowedUsers?.mode || 'all';
    if (mode === 'all') return true;
    if (!user) return false;
    if (mode === 'users') return (policy.allowedUsers.userIds || []).includes(user.id);
    if (mode === 'roles') {
        const roles = policy.allowedUsers.roles || [];
        // The legacy 'admin' org role is the same role as 'org_admin'.
        const role = user.orgRole === 'admin' ? 'org_admin' : user.orgRole;
        return !!role && (roles.includes(role) || (role === 'org_admin' && roles.includes('admin')));
    }
    return false;
}

module.exports = {
    DEFAULT_POLICY,
    PolicySchema,
    normalizePolicy,
    getOrgMcpPolicy,
    saveOrgMcpPolicy,
    userAllowedByPolicy,
    _test: { setDeps, storageKey },
};
