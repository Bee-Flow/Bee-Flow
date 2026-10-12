/**
 * Named MCP access tokens: the caller's own, over the session.
 *
 *   GET    /api/mcp-tokens        → { tokens, legacy: { exists }, eligibility, mcpBaseUrl }
 *   POST   /api/mcp-tokens        { name, scopes, ipAllowlist?, expiresAt? } → 201 { token, record }
 *   PATCH  /api/mcp-tokens/:id    { enabled } → 200 { record }  (switch off / on; revoked stays revoked)
 *   DELETE /api/mcp-tokens/:id    → 204
 *
 * The plaintext token is in the POST answer once and is not stored (only its
 * sha256 is), so there is nothing to show later. A user sees and revokes only
 * their own tokens; a colleague's id answers 404, the same as an unknown one.
 *
 * A token never grants more than its creator can do: `eligibility` (see
 * auth/mcpAccess/eligibility.js) says which servers the caller may put on one,
 * and POST refuses the rest with 403 scope_not_permitted, or 403
 * mcp_not_allowed when the organisation's policy keeps the caller off MCP.
 * `mcpBaseUrl` is the origin external clients reach this server on, for the
 * `claude mcp add` line.
 *
 * The one-per-user legacy token (routes/mcpServerTokens.js) keeps working and
 * keeps its own routes; `legacy.exists` only tells the UI to label it.
 */

const express = require('express');
const { z } = require('zod');
const { validate } = require('../core/http/validate');
const { notFound, unauthorized } = require('../core/http/errors');
const { forbidden } = require('../shared/httpErrors');
const { normalizeScopes } = require('../auth/mcpAccess/scopes');
const { eligibleServers, firstRefusedScope } = require('../auth/mcpAccess/eligibility');
const { resolvePublicBaseUrl } = require('../automation/publicUrl');
const { createToken, listTokens, revokeToken, setTokenEnabled } = require('../auth/mcpAccess/tokenStore');
const configStore = require('../stores/configStore');
const { SECRET_KEY } = require('../auth/mcpToken');
const userStore = require('../stores/userStore');
const { resolveMcpOrgId } = require('../auth/mcpAccess/orgResolve');

const router = express.Router();

const NO_QUERY = z.object({}).strict('This route takes no query parameters.');

const CreateBody = z.preprocess((v) => (v === undefined || v === null ? {} : v), z.object({
    name: z.string({ required_error: 'Give the token a name.', invalid_type_error: 'Give the token a name.' }).trim().min(1, 'Give the token a name.').max(80, 'A token name can be 80 characters at most.'),
    // The scope shape (servers, levels, tool lists) is checked by normalizeScopes,
    // which words its refusals for the person creating the token.
    scopes: z.record(z.unknown(), { required_error: 'Choose what the token may access.', invalid_type_error: 'Choose what the token may access.' }),
    ipAllowlist: z.array(z.string(), { invalid_type_error: 'The IP allow-list must be a list.' }).optional(),
    expiresAt: z.string({ invalid_type_error: 'The expiry must be a date.' }).nullable().optional(),
}).strict('Send only name, scopes, ipAllowlist and expiresAt.'));

/**
 * The real per-server predicates: the very functions the three MCP routers
 * call per request. Loaded lazily (they pull in their builders), and only when
 * the operator's flag for that server is on, which index.js has already
 * required by then anyway.
 */
const serverChecks = () => ({
    automations: {
        enabled: () => require('../automation/mcpBuilder').isEnabled(),
        entitled: (userId) => require('./mcpAutomations').assertEntitled(userId),
    },
    studio: {
        enabled: () => require('../appStudio/mcpBuilder').isEnabled(),
        entitled: (userId) => require('./mcpStudio').assertCapability(userId),
    },
    cms: {
        enabled: () => require('../cms/mcp').isEnabled(),
        isAdmin: (user) => require('./mcpCms').isCmsAdmin(user),
    },
});

/** Test seam: replaces how eligibility is worked out. */
let eligibilityOverride = null;

/** What the caller may put on a token. `account` is the fresh user row. */
const eligibilityOf = (account) => (eligibilityOverride
    ? eligibilityOverride(account)
    : eligibleServers(account, { servers: serverChecks() }));

const IdParams = z.object({ id: z.string().min(1).max(64) });

const PatchBody = z.object({
    enabled: z.boolean({ required_error: 'Say whether the token is on or off.', invalid_type_error: 'Say whether the token is on or off.' }),
}).strict('Send only enabled.');

const callerOf = (req) => {
    const user = req.session?.user;
    if (!user?.id) throw unauthorized();
    return user;
};

/** The caller's tokens, and whether they also hold the legacy one. Never a secret. */
router.get('/', validate({ query: NO_QUERY }), async (req, res) => {
    const user = callerOf(req);
    const tokens = (await listTokens(user.id)).map(({ id, name, scopes, ipAllowlist, expiresAt, lastUsedAt, createdAt, revokedAt, disabledAt, enabled }) => ({
        id, name, scopes, ipAllowlist, expiresAt, lastUsedAt, createdAt, revokedAt, disabledAt, enabled,
    }));
    const [stored, revoked] = await Promise.all([
        configStore.getSecret(SECRET_KEY(user.id)),
        configStore.getSecret(`${SECRET_KEY(user.id)}_revoked`),
    ]);
    const account = (await userStore.getUser(user.id)) || user;
    res.json({
        tokens,
        legacy: { exists: !!stored && revoked !== '1' },
        eligibility: await eligibilityOf(account),
        mcpBaseUrl: resolvePublicBaseUrl(req),
    });
});

router.post('/', validate({ body: CreateBody }), async (req, res) => {
    const user = callerOf(req);
    // The org the token is minted for: the home org, else the org a group grants
    // (a member can have no home org). Read fresh: the session copy has no groups.
    // A failed read is a 500, not a token without an org.
    const account = (await userStore.getUser(user.id)) || user;
    const orgId = await resolveMcpOrgId(account);
    const scopes = normalizeScopes(req.body.scopes);
    // A token never grants more than its creator can do.
    const eligibility = await eligibilityOf(account);
    if (!eligibility.policy.allowed) {
        throw forbidden('mcp_not_allowed', eligibility.policy.reason === 'unavailable'
            ? 'Your access to MCP could not be checked right now. Try again in a moment.'
            : 'Your organisation does not allow you to use MCP, so you cannot create a token.');
    }
    const refused = firstRefusedScope(scopes, eligibility);
    if (refused) {
        throw forbidden('scope_not_permitted', refused.why === 'not_enabled'
            ? `${refused.label} over MCP is not switched on for this server, so a token cannot include it.`
            : refused.publish
                ? `You cannot publish ${refused.label} yourself, so a token cannot either.`
                : `You do not have access to ${refused.label} yourself, so a token cannot include it.`);
    }
    const { token, record } = await createToken({
        userId: user.id,
        orgId,
        name: req.body.name,
        scopes,
        ipAllowlist: req.body.ipAllowlist,
        expiresAt: req.body.expiresAt,
    });
    await userStore.logAccessAudit(
        'mcp.token.create', 'mcp_token', record.id, user.id,
        null,
        { name: record.name, scopes: record.scopes, ipAllowlist: record.ipAllowlist, expiresAt: record.expiresAt },
        orgId,
    );
    res.status(201).json({ token, record });
});

router.patch('/:id', validate({ params: IdParams, body: PatchBody }), async (req, res) => {
    const user = callerOf(req);
    const record = await setTokenEnabled(user.id, req.params.id, req.body.enabled);
    if (!record) throw notFound('token_not_found', 'No such token.');
    await userStore.logAccessAudit(
        req.body.enabled ? 'mcp.token.enable' : 'mcp.token.disable', 'mcp_token', record.id, user.id,
        { name: record.name }, { enabled: record.enabled },
        record.orgId,
    );
    const { id, name, scopes, ipAllowlist, expiresAt, lastUsedAt, createdAt, revokedAt, disabledAt, enabled } = record;
    res.json({ record: { id, name, scopes, ipAllowlist, expiresAt, lastUsedAt, createdAt, revokedAt, disabledAt, enabled } });
});

router.delete('/:id', validate({ params: IdParams }), async (req, res) => {
    const user = callerOf(req);
    const record = await revokeToken(user.id, req.params.id);
    if (!record) throw notFound('token_not_found', 'No such token.');
    await userStore.logAccessAudit(
        'mcp.token.revoke', 'mcp_token', record.id, user.id,
        { name: record.name }, { revokedAt: record.revokedAt },
        record.orgId,
    );
    res.status(204).end();
});

module.exports = router;
module.exports._test = { setEligibility(fn) { eligibilityOverride = fn || null; } };
