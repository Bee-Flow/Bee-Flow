// @typecheck noImplicitAny
/**
 * MCP library API — mounted at /api/mcp-library.
 *
 *   /org/*      organisation admins: their organisation's library
 *               (requirePrimaryOrgAdmin: an org admin of the caller's OWN
 *               organisation, never one reached through a group elsewhere)
 *               plus the MCP marketplace licence.
 *   /me/*       any member: the servers they may use that need a key, and
 *               their own key for each.
 *   /policy     the server administrator: what organisation admins may
 *               install (core/customIntegrations/mcpLibrary/policy.js).
 *
 * The server-wide servers themselves (installed by the server administrator,
 * possibly running on this host) keep their own API under /ai/mcp-servers.
 * Nothing here can start a process: organisation libraries are remote-only.
 *
 * Bodies are closed zod schemas, so a key this API does not know is refused
 * by name rather than ignored. Everything that connects to a remote server
 * (probe, install, refresh, a new key) is rate-limited per user.
 */

const express = require('express');
const { z, typeError } = require('../utils/zod');
const { worded } = require('../core/http/schemaParts');
const { validate } = require('../core/http/validate');
const { HttpError } = require('../core/http/errors');
const { perUserRateLimit } = require('../utils/perUserRateLimit');
const { requireAuth, requireSuperAdmin, requirePrimaryOrgAdmin, requireActiveOrgForMutations, isSuperAdmin } = require('../auth/permissions');
const { requireFeature } = require('../license/middleware');
const service = require('../core/customIntegrations/mcpLibrary/service');
const members = require('../core/customIntegrations/mcpLibrary/members');
const policyModule = require('../core/customIntegrations/mcpLibrary/policy');
const { bestEffort } = require('../utils/bestEffort');
const { sessionUser } = require('../core/http/sessionUser');

const router = express.Router();

// A suspended organisation can read its library but not change it.
router.use(requireActiveOrgForMutations());

// Connecting out is the expensive and the abusable part: one probe is one
// outbound session to a host the caller picked.
const connectLimit = perUserRateLimit({ windowMs: 60_000, max: 12, name: 'mcp-library-connect' });

// ── Schemas ─────────────────────────────────────────────────────────

/** @param {import('zod').ZodRawShape} shape */
const bodyOf = (shape) => z.preprocess((v) => (v === undefined || v === null ? {} : v), z.object(shape).strict());

const CATALOG_ID = worded('catalogId is a library id.').regex(/^[a-z0-9_]{2,40}$/, 'catalogId is a library id.');
const URL_TEXT = 'url is an https address.';
const Url = worded(URL_TEXT).trim().min(1, URL_TEXT).max(2048, 'That address is too long.');
const Credential = worded('The key must be text.').max(4096, 'The key is at most 4096 characters.');
const Auth = z.object({
    style: z.enum(['none', 'bearer', 'header'], { error: () => 'Authentication is none, bearer or header.' }),
    header: worded('header is a header name.').max(64).optional(),
}).strict();
const ToolList = z.array(worded('A tool name must be text.').min(1).max(128), { error: typeError({ invalid: 'tools is a list of tool names.' }) }).max(100, 'At most 100 tools.');
const Access = z.object({
    mode: z.enum(['everyone', 'groups'], { error: () => "access.mode is 'everyone' or 'groups'." }),
    groupIds: z.array(worded('A group id must be text.').min(1).max(200)).max(200).optional(),
}).strict();

const ProbeBody = z.object({
    catalogId: CATALOG_ID.optional(),
    url: Url.optional(),
    auth: Auth.optional(),
    credential: Credential.optional(),
}).strict().refine(b => b.catalogId || b.url, { message: 'Pick a server from the library or enter an address.' });

const InstallBody = z.object({
    catalogId: CATALOG_ID.optional(),
    url: Url.optional(),
    auth: Auth.optional(),
    name: worded('name must be text.').trim().max(120, 'A name is at most 120 characters.').optional(),
    description: worded('description must be text.').max(500, 'A description is at most 500 characters.').optional(),
    credential: Credential.optional(),
    credentialMode: z.enum(['shared', 'personal'], { error: () => "credentialMode is 'shared' or 'personal'." }).default('shared'),
    tools: ToolList.optional(),
    access: Access.prefault({ mode: 'everyone' }),
}).strict().refine(b => b.catalogId || b.url, { message: 'Pick a server from the library or enter an address.' });

const UpdateBody = z.object({
    enabled: z.boolean({ error: typeError({ invalid: 'enabled is true or false.' }) }).optional(),
    tools: ToolList.optional(),
    access: Access.optional(),
    credentialMode: z.literal('personal', { error: () => "Only 'personal' can be set here; a shared key is set with PUT …/credential." }).optional(),
}).strict();

const CredentialBody = z.object({ value: Credential.min(1, 'Enter the key.') }).strict();

const ServerWideBody = z.object({
    access: z.object({
        mode: z.enum(['everyone', 'groups', 'nobody'], { error: () => "access.mode is 'everyone', 'groups' or 'nobody'." }),
        groupIds: z.array(worded('A group id must be text.').min(1).max(200)).max(200).optional(),
    }).strict(),
}).strict();

const PolicyBody = z.object({
    remote: z.enum(policyModule.REMOTE_MODES, { error: () => `remote is one of ${policyModule.REMOTE_MODES.join(', ')}.` }),
    allowedHosts: z.array(worded('A host must be text.').max(253), { error: typeError({ invalid: 'allowedHosts is a list of host names.' }) })
        .max(policyModule.MAX_ALLOWED_HOSTS, `At most ${policyModule.MAX_ALLOWED_HOSTS} hosts.`)
        .default([]),
}).strict();

const NoBody = bodyOf({});

// ── Server administrator: the policy ────────────────────────────────

router.get('/policy', requireAuth, requireSuperAdmin, async (req, res) => {
    const { publicCatalog } = require('../core/customIntegrations/mcpLibrary/catalog');
    res.json({
        policy: await policyModule.getPolicy(),
        modes: policyModule.REMOTE_MODES,
        officialHosts: [...new Set(publicCatalog().filter(e => !e.selfHosted).map(e => e.host).filter(Boolean))],
    });
});

router.put('/policy', requireAuth, requireSuperAdmin, validate({ body: PolicyBody }), async (/** @type {import('express').Request<{}, any, import('zod').infer<typeof PolicyBody>, import('qs').ParsedQs>} */ req, res) => {
    const bad = req.body.allowedHosts.filter(/** @param {string} h */ h => !policyModule.normalizeHostPattern(h));
    if (bad.length) {
        throw new HttpError(400, 'invalid_host', `Not a host name: ${bad.slice(0, 3).join(', ')}. Use names like mcp.example.com or *.example.com, without https:// or a path.`);
    }
    const before = await policyModule.getPolicy();
    const policy = await policyModule.setPolicy(req.body);
    try {
        await require('../stores/userStore').logAccessAudit('mcp_library.policy_update', 'platform', policyModule.POLICY_KEY, sessionUser(req).id, before, policy, null);
    } catch (err) { bestEffort('routes/mcpLibrary:anon', err); /* best effort */ }
    // Every org's tool list and capability set depends on it.
    try {
        const ent = require('../core/entitlements/entitlements');
        ent.registry.invalidateCustomIntegrationCache();
    } catch (err) { bestEffort('routes/mcpLibrary:anon#2', err); /* best effort */ }
    res.json({ policy });
});

// ── Members: their own keys ─────────────────────────────────────────

router.get('/me', requireAuth, async (req, res) => {
    res.json(await members.listForMember(req));
});

router.put('/me/:id/credential', requireAuth, connectLimit, validate({ body: CredentialBody }), /** @param {import('express').Request<{ id: string }>} req */ async (req, res) => {
    res.json(await members.saveOwnCredential(req, req.params.id, req.body.value));
});

router.delete('/me/:id/credential', requireAuth, /** @param {import('express').Request<{ id: string }>} req */ async (req, res) => {
    res.json(await members.deleteOwnCredential(req, req.params.id));
});

// ── Organisation admins: the library ────────────────────────────────

/**
 * Request after the `id` param loader stashes the library row on it.
 * @typedef {import('express').Request & { libraryRow?: Awaited<ReturnType<typeof service.loadOrgRow>> }} LibraryReq
 */
const org = express.Router();
org.use(requirePrimaryOrgAdmin(), requireFeature('mcp_marketplace'));

// Library row loader: another organisation's row, a builder row and a
// missing row are all the same 404, so the API is no existence oracle.
org.param('id', /** @param {LibraryReq} req */ async (req, res, next, id) => {
    const row = await service.loadOrgRow(req.primaryOrgId, id);
    if (!row) return next(new HttpError(404, 'not_found', 'Not found'));
    req.libraryRow = row;
    next();
});

org.get('/', async (req, res) => {
    res.json(await service.getLibrary({ orgId: req.primaryOrgId, isServerAdmin: isSuperAdmin(req) }));
});

org.post('/probe', connectLimit, validate({ body: ProbeBody }), async (/** @type {import('express').Request<{}, any, import('zod').infer<typeof ProbeBody>, import('qs').ParsedQs>} */ req, res) => {
    res.json(await service.probe(req.body));
});

org.post('/servers', connectLimit, validate({ body: InstallBody }), async (/** @type {import('express').Request<{}, any, import('zod').infer<typeof InstallBody>, import('qs').ParsedQs>} */ req, res) => {
    const server = await service.install({ orgId: req.primaryOrgId, actorUserId: sessionUser(req).id, input: req.body });
    res.status(201).json({ server });
});

org.patch('/servers/:id', connectLimit, validate({ body: UpdateBody }), /** @param {LibraryReq} req */ async (req, res) => {
    const server = await service.update({ orgId: req.primaryOrgId, row: req.libraryRow, actorUserId: sessionUser(req).id, patch: req.body });
    res.json({ server });
});

org.post('/servers/:id/refresh', connectLimit, validate({ body: NoBody }), /** @param {LibraryReq} req */ async (req, res) => {
    res.json(await service.refresh({ orgId: req.primaryOrgId, row: req.libraryRow, actorUserId: sessionUser(req).id }));
});

org.put('/servers/:id/credential', connectLimit, validate({ body: CredentialBody }), /** @param {LibraryReq} req */ async (req, res) => {
    res.json(await service.setSharedCredential({ orgId: req.primaryOrgId, row: req.libraryRow, actorUserId: sessionUser(req).id, value: req.body.value }));
});

org.delete('/servers/:id', /** @param {LibraryReq} req */ async (req, res) => {
    res.json(await service.uninstall({ orgId: req.primaryOrgId, row: req.libraryRow, actorUserId: sessionUser(req).id }));
});

org.put('/server-wide/:serverId', validate({ body: ServerWideBody }), /** @param {import('express').Request<{ serverId: string }>} req */ async (req, res) => {
    const access = await service.setServerWideAccess({
        orgId: req.primaryOrgId, serverId: req.params.serverId, actorUserId: sessionUser(req).id, access: req.body.access,
    });
    res.json({ access });
});

router.use('/org', requireAuth, org);

module.exports = router;
