/**
 * Integration Connections API — named connections + sharing.
 *
 * Lets a user manage MULTIPLE named credentials per integration and LEND a
 * specific connection to a user / group / org (full delegation). Default for
 * any shared resource is bring-your-own (no grant). Org isolation is enforced
 * here AND structurally in the resolver: a grant can never cross orgs.
 *
 * Secrets are never returned by any endpoint — only presence/metadata.
 */

const express = require('express');
const store = require('../../stores/integrationConnectionStore');
const userStore = require('../../stores/userStore');
const { requireActiveOrgForMutations } = require('../../auth/permissions');
const { perUserRateLimit } = require('../../utils/perUserRateLimit');
const { validate } = require('../../core/http/validate');
const { z } = require('zod');
const log = require('../../telemetry/log');

const router = express.Router();

// Suspended orgs can read their connections but not mutate them.
router.use(requireActiveOrgForMutations());

// Credential writes are low-frequency by nature. The cap exists so the share
// endpoint (which takes an arbitrary email) can't be driven as a bulk directory
// probe, and so credential creation can't be used to bloat the vault.
const writeLimit = perUserRateLimit({ windowMs: 60_000, max: 30 });
const shareLimit = perUserRateLimit({ windowMs: 60_000, max: 10 });

// requireAuth is the canonical gate from auth/permissions (verifies the
// user still exists in the DB, cached 5s, and destroys deleted-user sessions).
const { requireAuth } = require('../../auth/permissions');

function isAdmin(req) {
    return !!(req.session?.isAdmin || req.session?.user?.role === 'admin');
}

const PROVIDER_RE = /^[a-z0-9][a-z0-9_:-]{0,63}$/i;
// The kind / grantee-type / resource-type vocabularies live in the schemas
// below — one list each, read by every route that takes them, rather than a
// Set some routes checked against and others did not.

// ── Provider 'http' credential contracts (Feature C) ────────────────
// Per-kind: which secret fields are REQUIRED (the encrypted blob is exactly
// these fields) and which secretMeta keys the client may set. secret_meta is
// plaintext display data — a secret value landing there would be a plaintext
// leak, hence the strict allowlist. clientIdHint is derived server-side only.
const HTTP_KIND_SPECS = {
    bearer:    { secretFields: ['token'],                    metaAllowed: [] },
    api_key:   { secretFields: ['token'],                    metaAllowed: ['headerName'] },
    basic:     { secretFields: ['username', 'password'],     metaAllowed: ['username'] },
    oauth2_cc: { secretFields: ['client_id', 'client_secret'], metaAllowed: ['tokenUrl', 'scope', 'tokenAuthMethod'] },
};
const HEADER_NAME_RE = /^[A-Za-z0-9-]{1,64}$/;
// Headers that must never carry an injected credential (request smuggling /
// routing surfaces, not auth carriers).
const FORBIDDEN_HEADER_NAMES = new Set(['host', 'content-length', 'transfer-encoding', 'connection']);
const OAUTH2_TOKEN_AUTH_METHODS = new Set(['client_secret_post', 'client_secret_basic']);

// ── What a caller may send ──────────────────────────────────────────
//
// Credentials, and who is lent them. Four of these keys were read in a way
// that turned a caller's mistake into a 200 over the wrong outcome:
//
//   - PATCH `makeDefault === true` versus POST `!!makeDefault`. The same key,
//     two different rules in one file: `{ makeDefault: 'false' }` on CREATE
//     made the connection the org default (the string is truthy), while
//     `{ makeDefault: 'true' }` on PATCH did nothing at all — and answered
//     200 with the re-read connection, which the UI renders as "saved".
//   - PATCH `typeof label === 'string'`. A label of the wrong JSON type was
//     skipped in silence under the same 200, so the rename box reverted on
//     the next reload with no error to show.
//   - GET `?includeShared` was `=== '1'`, so `?includeShared=true` returned
//     the caller's OWN connections only — the lent ones the parameter exists
//     to add simply were not there, under a 200 the client cannot tell from
//     "nothing is lent to you".
//   - DELETE `?force` was `!== '1'`, so `?force=true` kept answering 409
//     "Connection is shared" however many times the caller retried.
//
// Both flags now take '1'/'0'/'true'/'false' and refuse anything else, which
// is a deliberate WIDENING: the point is that no spelling may quietly mean
// its opposite.
//
// `resourceType` is the other asymmetry. POST /:id/grants checked it against
// VALID_RESOURCE_TYPES; GET /required and GET /grants did not, so a typo
// there narrowed the answer to nothing instead of failing — a pre-flight
// saying "connect this yourself" over a credential that had in fact been
// lent. All three read from the same set now.
//
// `secret` and `secretMeta` stay OPEN objects on purpose: their keys are the
// credential's own fields, they differ per provider, and for provider 'http'
// sanitizeHttpSecret/sanitizeHttpMeta below hold the real per-kind contract
// (exact secret fields, meta allow-list, header-name and token-URL rules).
// The schema only says they are objects — which is the check the route used
// to make by hand.

/** A string whose every refusal — including "you left it out" — is a sentence. */
const worded = (message) => z.string({ required_error: message, invalid_type_error: message });

/** A body that also accepts no body at all: Express 5 leaves `req.body` undefined then. */
const bodyOf = (shape) => z.preprocess((v) => (v === undefined || v === null ? {} : v), z.object(shape).strict());

/** A query flag. Present and readable → boolean; present and unreadable → 400. */
const flag = (name) => z.enum(['1', '0', 'true', 'false'], {
    errorMap: () => ({ message: `${name} is 1 or 0.` }),
}).transform((v) => v === '1' || v === 'true').optional();

const anyObject = (name) => z.record(z.unknown(), { invalid_type_error: `${name} must be an object of fields.` });

const PROVIDER_TEXT = 'Invalid provider';
const GRANTEE_TEXT = 'Invalid granteeType';
const RESOURCE_TEXT = 'Invalid resourceType';
const MINE_TEXT = 'mine must be "outgoing" or "incoming"';

const resourceType = () => z.enum(['agent', 'webpage', 'skill', 'automation', 'studio_app'], {
    errorMap: () => ({ message: RESOURCE_TEXT }),
});

const ListQuery = z.object({
    provider: worded('provider must be text.').optional(),
    includeShared: flag('includeShared'),
}).strict();

const RequiredQuery = z.object({
    providers: worded('providers is a comma-separated list.').optional(),
    resourceType: resourceType().nullish(),
    resourceId: worded('resourceId must be text.').nullish(),
}).strict();

const GrantsQuery = z.object({
    mine: z.enum(['outgoing', 'incoming'], { errorMap: () => ({ message: MINE_TEXT }) }).optional(),
    resourceType: resourceType().optional(),
    resourceId: worded('resourceId must be text.').optional(),
    connectionId: worded('connectionId must be text.').optional(),
}).strict();

const DeleteQuery = z.object({ force: flag('force') }).strict();

const CreateBody = z.object({
    provider: worded(PROVIDER_TEXT).regex(PROVIDER_RE, PROVIDER_TEXT),
    label: worded('A connection label must be text.').optional(),
    kind: z.enum(['oauth', 'api_key', 'basic', 'mcp', 'bearer', 'oauth2_cc'], {
        errorMap: () => ({ message: 'Invalid kind' }),
    }).optional(),
    secret: anyObject('secret').nullish(),
    secretMeta: anyObject('secretMeta').nullish(),
    makeDefault: z.boolean({ invalid_type_error: 'makeDefault is true or false.' }).optional(),
}).strict();

const PatchBody = bodyOf({
    label: worded('A connection label must be text.').optional(),
    makeDefault: z.boolean({ invalid_type_error: 'makeDefault is true or false.' }).optional(),
    secret: anyObject('secret').nullish(),
    secretMeta: anyObject('secretMeta').nullish(),
});

const GrantBody = bodyOf({
    granteeType: z.enum(['user', 'group', 'org'], { errorMap: () => ({ message: GRANTEE_TEXT }) }),
    granteeId: worded('granteeId must be text.').nullish(),
    granteeEmail: worded('granteeEmail must be text.').trim().nullish(),
    resourceType: resourceType().nullish(),
    resourceId: worded('resourceId must be text.').nullish(),
    // '' is how the share panel spells "no expiry", alongside null — see
    // daysFromNowIso in agent-hub ConnectionsManager.
    expiresAt: worded('expiresAt must be a valid date').nullish(),
}).superRefine((v, ctx) => {
    if ((v.resourceType == null) !== (v.resourceId == null)) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom, path: ['resourceId'],
            message: 'resourceType and resourceId must be set together',
        });
    }
    if (v.expiresAt) {
        const parsed = new Date(v.expiresAt);
        // Unvalidated input reached .toISOString() and threw a RangeError,
        // surfacing as a 500.
        if (Number.isNaN(parsed.getTime())) {
            ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['expiresAt'], message: 'expiresAt must be a valid date' });
        } else if (parsed.getTime() <= Date.now()) {
            ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['expiresAt'], message: 'expiresAt must be in the future' });
        }
    }
});

function clientIdHintFor(clientId) {
    return `${String(clientId).slice(0, 4)}…`;
}

// Validate + sanitize the SECRET blob for an http credential. Returns
// { error } or { secret } holding exactly the per-kind required fields.
function sanitizeHttpSecret(kind, secret) {
    const spec = HTTP_KIND_SPECS[kind];
    if (!spec) return { error: `kind "${kind}" is not valid for provider "http"` };
    const src = (secret && typeof secret === 'object' && !Array.isArray(secret)) ? secret : {};
    const out = {};
    for (const f of spec.secretFields) {
        if (typeof src[f] !== 'string' || !src[f].trim()) {
            return { error: `secret.${f} is required for kind "${kind}"` };
        }
        out[f] = src[f];
    }
    return { secret: out };
}

// Validate + sanitize secretMeta for an http credential (strict allowlist;
// any client-sent clientIdHint is silently discarded — it is derived).
function sanitizeHttpMeta(kind, secretMeta) {
    const spec = HTTP_KIND_SPECS[kind];
    if (!spec) return { error: `kind "${kind}" is not valid for provider "http"` };
    const src = (secretMeta && typeof secretMeta === 'object' && !Array.isArray(secretMeta)) ? { ...secretMeta } : {};
    delete src.clientIdHint;
    for (const k of Object.keys(src)) {
        if (!spec.metaAllowed.includes(k)) return { error: `secretMeta.${k} is not allowed for kind "${kind}"` };
    }
    const out = {};
    if (kind === 'api_key') {
        const headerName = src.headerName;
        if (typeof headerName !== 'string' || !HEADER_NAME_RE.test(headerName)) {
            return { error: 'secretMeta.headerName is required: 1-64 letters, digits, or hyphens' };
        }
        if (FORBIDDEN_HEADER_NAMES.has(headerName.toLowerCase())) {
            return { error: `secretMeta.headerName "${headerName}" cannot carry a credential` };
        }
        out.headerName = headerName;
    }
    if (kind === 'basic' && typeof src.username === 'string' && src.username) {
        out.username = src.username; // display convenience only
    }
    if (kind === 'oauth2_cc') {
        let parsed = null;
        try { parsed = new URL(String(src.tokenUrl || '')); } catch (_) { /* handled below */ }
        if (!parsed || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) {
            return { error: 'secretMeta.tokenUrl must be a valid http(s) URL' };
        }
        out.tokenUrl = String(src.tokenUrl);
        if (src.scope !== undefined) {
            if (typeof src.scope !== 'string') return { error: 'secretMeta.scope must be a string' };
            if (src.scope.trim()) out.scope = src.scope.trim();
        }
        const method = src.tokenAuthMethod === undefined ? 'client_secret_post' : src.tokenAuthMethod;
        if (!OAUTH2_TOKEN_AUTH_METHODS.has(method)) {
            return { error: 'secretMeta.tokenAuthMethod must be "client_secret_post" or "client_secret_basic"' };
        }
        out.tokenAuthMethod = method;
    }
    return { secretMeta: out };
}

// Best-effort credential audit — mirrors configStore._auditCredentialChange:
// lazy require, swallow errors, record provider/label/kind — NEVER values.
async function auditConnectionChange(action, conn, userId) {
    try {
        const { logAccessAudit } = require('../../stores/userStore');
        await logAccessAudit(
            `credential.${action}`, 'integration_connection', conn.id, userId || null, null,
            { provider: conn.provider, label: conn.label, kind: conn.kind, action },
            conn.orgId || null,
        );
    } catch (_) { /* non-fatal — auditing must never block a credential write */ }
}

// Resolve the caller's org (sentinel-normalized) + group ids.
async function callerContext(req) {
    const userId = req.session.user.id;
    const user = await userStore.getUser(userId).catch(() => null);
    const orgId = store.resolveOrgId(user?.organizationId);
    const groups = Array.isArray(user?.groups) ? user.groups : [];
    return { userId, orgId, groups, user };
}

// Attach a human label for each grantee so the UI can show "sam@acme.com"
// instead of a raw uuid. Safe to resolve: these rows are already scoped to the
// caller (grants they made, or grants made to them), and share-time org
// isolation guarantees the grantee is a tenant peer. Never adds anything the
// caller could not already see; failures degrade to the bare id.
async function decorateGrantees(grants) {
    if (!Array.isArray(grants) || grants.length === 0) return grants || [];
    const userIds = new Set();
    const groupIds = new Set();
    for (const g of grants) {
        if (!g.grantee_id) continue;
        if (g.grantee_type === 'user') userIds.add(g.grantee_id);
        else if (g.grantee_type === 'group') groupIds.add(g.grantee_id);
    }
    const users = new Map();
    await Promise.all([...userIds].map(async (id) => {
        const u = await userStore.getUser(id).catch(() => null);
        if (u) users.set(id, u.email || u.name || null);
    }));
    const groups = new Map();
    if (groupIds.size > 0) {
        const all = await userStore.getAllGroups().catch(() => []);
        for (const grp of all) if (groupIds.has(grp.id)) groups.set(grp.id, grp.name || null);
    }
    return grants.map(g => ({
        ...g,
        grantee_label: g.grantee_type === 'user' ? (users.get(g.grantee_id) || null)
            : g.grantee_type === 'group' ? (groups.get(g.grantee_id) || null)
                : null,
    }));
}

// Owner always; an admin only within the connection's own org. Admin role must
// never reach another tenant's credentials — a cross-org PATCH of e.g. an
// oauth2_cc tokenUrl would turn into secret disclosure on the owner's next run.
async function ownsConnection(req, conn) {
    if (!conn) return false;
    if (conn.ownerUserId === req.session.user.id) return true;
    if (!isAdmin(req)) return false;
    const { orgId } = await callerContext(req);
    return store.resolveOrgId(conn.orgId) === orgId;
}

// ── CRUD ────────────────────────────────────────────────────────────

// List the caller's named connections (presence-only; no secrets).
// ?includeShared=1 (with ?provider=) also returns connections LENT to the
// caller; each entry then carries `access: 'own' | 'lent'`.
router.get('/', requireAuth, validate({ query: ListQuery }), async (req, res) => {
    try {
        const provider = req.query.provider ? String(req.query.provider) : null;
        if (req.query.includeShared === true && provider) {
            const { userId, orgId, groups } = await callerContext(req);
            const connections = await store.listAccessibleConnections({ userId, orgId, groups, provider });
            return res.json({ connections });
        }
        const connections = await store.listConnectionsForUser(req.session.user.id, provider);
        res.json({ connections });
    } catch (err) {
        log.error('[ConnectionsAPI] list error:', err.message);
        res.status(500).json({ error: 'Could not load connections' });
    }
});

// Pre-flight for a recipient: which providers must they connect (BYO) vs are
// lent to them. Phase 2 takes an explicit `?providers=a,b`; Phase 3 derives the
// provider list from the resource server-side.
router.get('/required', requireAuth, validate({ query: RequiredQuery }), async (req, res) => {
    try {
        const { userId, orgId, groups } = await callerContext(req);
        const providers = String(req.query.providers || '')
            .split(',').map(s => s.trim()).filter(Boolean);
        const resourceType = req.query.resourceType ? String(req.query.resourceType) : null;
        const resourceId = req.query.resourceId ? String(req.query.resourceId) : null;
        const requiresConnection = [];
        const lent = [];
        for (const provider of providers) {
            const r = await store.resolveConnectionForRun({
                runningUserId: userId, runningUserOrgId: orgId, runningUserGroups: groups,
                provider, resourceType, resourceId,
            });
            if (r.mode === 'delegated') lent.push({ provider, connectionLabel: r.connectionLabel });
            else if (!r.available) {
                // The connections registry is the NEW credential store; most
                // Google/Microsoft users hold their credential in the LEGACY
                // per-user integration layer (SSO token/vault) — the layer the
                // runtime itself consults first (mailboxIdentity's ladder). A
                // pre-flight that only read the new store told those users to
                // "Connect gmail" above an app whose data was loading fine.
                // Lazy require: this route must stay loadable where the
                // appStudio layer is mocked away (its own tests).
                let legacyOk = false;
                try {
                    const { viewerHasIntegration } = require('../../appStudio/mailboxIdentity');
                    legacyOk = await viewerHasIntegration(provider, { userId, orgId });
                } catch { /* no legacy layer → the connection really is missing */ }
                if (!legacyOk) requiresConnection.push({ provider });
            }
        }
        res.json({ requiresConnection, lent });
    } catch (err) {
        log.error('[ConnectionsAPI] required error:', err.message);
        res.status(500).json({ error: 'Could not check required connections' });
    }
});

// List grants — outgoing (I lent) or incoming (lent to me).
//
// The caller scope is UNCONDITIONAL: it is never derived from whether an
// optional query param happens to be set. An earlier version applied its
// "default to what I lent" fallback only when `mine` was falsy and no
// connectionId was given, so `?mine=<junk>` or `?connectionId=<any uuid>`
// reached listGrants with an empty filter and returned every grant in the
// deployment, across all tenants.
router.get('/grants', requireAuth, validate({ query: GrantsQuery }), async (req, res) => {
    try {
        const { userId, orgId } = await callerContext(req);
        const mine = req.query.mine || 'outgoing';
        // Principal scope first — the remaining params only narrow it further.
        const filter = mine === 'incoming'
            ? { granteeId: userId, orgId }
            : { grantorUserId: userId };
        if (req.query.resourceType) filter.resourceType = String(req.query.resourceType);
        if (req.query.resourceId) filter.resourceId = String(req.query.resourceId);
        if (req.query.connectionId) filter.connectionId = String(req.query.connectionId);
        const grants = await store.listGrants(filter);
        res.json({ grants: await decorateGrantees(grants) });
    } catch (err) {
        log.error('[ConnectionsAPI] grants list error:', err.message);
        res.status(500).json({ error: 'Could not load shares' });
    }
});

// Revoke a grant — only the grantor, or an admin of the grant's OWN org.
// Admin power stops at the tenant boundary here exactly as it does in
// ownsConnection; a global isAdmin() check would let an admin of org A revoke
// org B's grants.
router.delete('/grants/:grantId', requireAuth, async (req, res) => {
    try {
        const grant = await store.getGrant(req.params.grantId);
        if (!grant) return res.status(404).json({ error: 'Grant not found' });
        if (grant.grantor_user_id !== req.session.user.id) {
            if (!isAdmin(req)) return res.status(403).json({ error: 'Only the grantor can revoke this grant' });
            const { orgId } = await callerContext(req);
            if (store.resolveOrgId(grant.org_id) !== orgId) {
                return res.status(403).json({ error: 'Only the grantor can revoke this grant' });
            }
        }
        const ok = await store.revokeGrant(req.params.grantId);
        res.json({ revoked: ok });
    } catch (err) {
        log.error('[ConnectionsAPI] revoke error:', err.message);
        res.status(500).json({ error: 'Could not revoke this share' });
    }
});

// Create a named connection.
router.post('/', requireAuth, writeLimit, validate({ body: CreateBody }), async (req, res) => {
    try {
        const { provider, label, kind = 'api_key', secret = null, secretMeta = null, makeDefault = false } = req.body;

        let secretObject = secret;
        let meta = (secretMeta && typeof secretMeta === 'object' && !Array.isArray(secretMeta)) ? secretMeta : {};
        if (String(provider) === 'http') {
            // Strict per-kind contract: exact secret fields, meta allowlist,
            // header-name/token-URL validation, derived clientIdHint.
            const s = sanitizeHttpSecret(kind, secret);
            if (s.error) return res.status(400).json({ error: s.error });
            const m = sanitizeHttpMeta(kind, secretMeta);
            if (m.error) return res.status(400).json({ error: m.error });
            secretObject = s.secret;
            meta = m.secretMeta;
            if (kind === 'oauth2_cc') meta.clientIdHint = clientIdHintFor(secretObject.client_id);
            if (kind === 'basic' && !meta.username) meta.username = secretObject.username;
        }

        const { orgId } = await callerContext(req);
        const conn = await store.createConnection({
            ownerUserId: req.session.user.id, orgId, provider: String(provider),
            label: label ? label.slice(0, 120) : 'Default', kind,
            secretObject, secretMeta: meta, makeDefault: makeDefault === true,
        });
        auditConnectionChange('create', conn, req.session.user.id).catch(() => {});
        res.status(201).json({ connection: conn });
    } catch (err) {
        log.error('[ConnectionsAPI] create error:', err.message);
        res.status(500).json({ error: 'Could not create this connection' });
    }
});

// Rename / set-default / update secret (write-only: secret in, never out).
// For provider 'http': secret rotation is FULL-blob replacement under the
// same per-kind contract as create; `secretMeta` may also be updated alone
// (allowlist-validated; derived fields like clientIdHint are preserved).
router.patch('/:id', requireAuth, writeLimit, validate({ body: PatchBody }), async (req, res) => {
    try {
        const conn = await store.getConnection(req.params.id);
        if (!conn) return res.status(404).json({ error: 'Connection not found' });
        if (!(await ownsConnection(req, conn))) return res.status(403).json({ error: 'Forbidden' });

        const { label, makeDefault, secret, secretMeta } = req.body;
        if (label !== undefined) await store.renameConnection(conn.id, label.slice(0, 120));

        const hasSecret = !!secret;
        if (conn.provider === 'http') {
            let newMeta = null;
            if (secretMeta !== undefined) {
                const m = sanitizeHttpMeta(conn.kind, secretMeta);
                if (m.error) return res.status(400).json({ error: m.error });
                newMeta = m.secretMeta;
            }
            if (hasSecret) {
                const s = sanitizeHttpSecret(conn.kind, secret);
                if (s.error) return res.status(400).json({ error: s.error });
                const meta = { ...(newMeta ?? conn.secretMeta ?? {}) };
                if (conn.kind === 'oauth2_cc') meta.clientIdHint = clientIdHintFor(s.secret.client_id);
                if (conn.kind === 'basic') meta.username = s.secret.username;
                await store.updateConnectionSecret(conn.id, s.secret, meta);
                auditConnectionChange('rotate', conn, req.session.user.id).catch(() => {});
            } else if (newMeta) {
                // Meta-only update keeps server-derived display fields. Audited:
                // for oauth2_cc a tokenUrl change redirects where the client
                // credentials get POSTed, so it must be traceable.
                if (conn.kind === 'oauth2_cc' && conn.secretMeta?.clientIdHint) newMeta.clientIdHint = conn.secretMeta.clientIdHint;
                if (conn.kind === 'basic' && !newMeta.username && conn.secretMeta?.username) newMeta.username = conn.secretMeta.username;
                await store.updateConnectionMeta(conn.id, newMeta);
                auditConnectionChange('update_meta', conn, req.session.user.id).catch(() => {});
            }
        } else if (hasSecret) {
            await store.updateConnectionSecret(conn.id, secret);
            auditConnectionChange('rotate', conn, req.session.user.id).catch(() => {});
        }
        if (makeDefault === true) await store.setDefault(conn.id);

        res.json({ connection: await store.getConnection(conn.id) });
    } catch (err) {
        log.error('[ConnectionsAPI] patch error:', err.message);
        res.status(500).json({ error: 'Could not update this connection' });
    }
});

// Delete — blocked if it backs an active grant unless ?force=1.
//
// For an OAuth provider the row is only METADATA: the live tokens sit in
// automation_credentials. Dropping the row alone left the user connected (and
// /status still reporting so), i.e. a delete that deleted nothing. So an owner
// deleting their own OAuth row also revokes the credential provider-side and
// clears the live session, exactly like POST /api/integrations/<p>/disconnect.
// An ADMIN deleting someone else's row only removes the row — revoking another
// user's live third-party access is not what "tidy up a connection" means.
router.delete('/:id', requireAuth, writeLimit, validate({ query: DeleteQuery }), async (req, res) => {
    try {
        const conn = await store.getConnection(req.params.id);
        if (!conn) return res.status(404).json({ error: 'Connection not found' });
        if (!(await ownsConnection(req, conn))) return res.status(403).json({ error: 'Forbidden' });

        const activeGrants = await store.listGrants({ connectionId: conn.id });
        if (activeGrants.length > 0 && req.query.force !== true) {
            return res.status(409).json({ error: 'Connection is shared', grants: activeGrants.length });
        }

        const isOwner = conn.ownerUserId === req.session.user.id;
        const isOAuthRow = conn.kind === 'oauth'
            && !!store._internals?.OAUTH_AUTOMATION_PROVIDERS?.has?.(conn.provider);
        let revoked = false;
        if (isOwner && isOAuthRow) {
            try {
                const { revokeProviderCredential } = require('../../auth/oauthRoutes');
                const result = await revokeProviderCredential(req.session.user.id, conn.provider);
                revoked = !!result.found;
            } catch (e) {
                // A provider-side failure must not strand the row: log and
                // continue so the user can still remove the connection.
                log.warn(`[ConnectionsAPI] provider revoke failed for ${conn.provider}: ${e.message}`);
            }
            if (req.session.oauthProvider === conn.provider) {
                delete req.session.accessToken;
                delete req.session.refreshToken;
                delete req.session.oauthProvider;
                delete req.session.oauthTokenSource;
                req.session.save?.();
            }
        }

        const ok = await store.deleteConnection(conn.id); // ON DELETE CASCADE drops grants
        if (ok) auditConnectionChange('delete', conn, req.session.user.id).catch(() => {});
        res.json({ deleted: ok, credentialRevoked: revoked });
    } catch (err) {
        log.error('[ConnectionsAPI] delete error:', err.message);
        res.status(500).json({ error: 'Could not delete this connection' });
    }
});

// Share (lend) a connection — org isolation enforced.
router.post('/:id/grants', requireAuth, shareLimit, validate({ body: GrantBody }), async (req, res) => {
    try {
        const conn = await store.getConnection(req.params.id);
        if (!conn) return res.status(404).json({ error: 'Connection not found' });
        if (!(await ownsConnection(req, conn))) return res.status(403).json({ error: 'Forbidden' });

        let { granteeId = null, expiresAt = null } = req.body;
        const { granteeType, granteeEmail = null, resourceType = null, resourceId = null } = req.body;

        // Lookup is deployment-global, so "no such account" and "account in
        // another tenant" MUST be indistinguishable — otherwise this endpoint
        // answers "does <email> have an account here?" for any address.
        // A directly-supplied granteeId keeps the explicit cross-org 403: the
        // caller already holds the id, so there is nothing left to disclose.
        const emailLookupUsed = granteeType === 'user' && !granteeId && !!granteeEmail;
        const NO_SUCH_TEAMMATE = 'No teammate with that email in your organization';
        if (emailLookupUsed) {
            const byEmail = await userStore.getUserByEmail(granteeEmail).catch(() => null);
            if (!byEmail) return res.status(404).json({ error: NO_SUCH_TEAMMATE });
            granteeId = byEmail.id;
        }
        // Shape, pairing and date are the schema's job now; what is left is
        // normalising the one it cannot: '' and null both mean "no expiry".
        expiresAt = expiresAt ? new Date(expiresAt).toISOString() : null;

        const ownerOrg = conn.orgId; // authoritative owner org (sentinel-normalized at create)

        // ── Org isolation: the grantee must live in the connection's org ──
        if (granteeType === 'user') {
            if (!granteeId) return res.status(400).json({ error: 'granteeId required for a user grant' });
            const grantee = await userStore.getUser(granteeId).catch(() => null);
            if (!grantee) {
                return res.status(404).json({ error: emailLookupUsed ? NO_SUCH_TEAMMATE : 'Grantee user not found' });
            }
            if (store.resolveOrgId(grantee.organizationId) !== ownerOrg) {
                return emailLookupUsed
                    ? res.status(404).json({ error: NO_SUCH_TEAMMATE })
                    : res.status(403).json({ error: 'Cross-org sharing is not allowed' });
            }
        } else if (granteeType === 'group') {
            if (!granteeId) return res.status(400).json({ error: 'granteeId required for a group grant' });
            const groups = await userStore.getAllGroups().catch(() => []);
            const group = groups.find(g => g.id === granteeId);
            if (!group) return res.status(404).json({ error: 'Grantee group not found' });
            if (store.resolveOrgId(group.organizationId) !== ownerOrg) {
                return res.status(403).json({ error: 'Cross-org sharing is not allowed' });
            }
        } else if (granteeType === 'org') {
            // Only the owner's own org. granteeId is the org id (or null = own org).
            granteeId = null;
        }

        const grant = await store.shareConnection({
            connectionId: conn.id, grantorUserId: req.session.user.id,
            granteeType, granteeId, resourceType, resourceId, expiresAt,
        });
        auditConnectionChange('share', conn, req.session.user.id).catch(() => {});
        res.status(201).json({ grant });
    } catch (err) {
        log.error('[ConnectionsAPI] share error:', err.message);
        res.status(500).json({ error: 'Could not share this connection' });
    }
});

module.exports = router;
