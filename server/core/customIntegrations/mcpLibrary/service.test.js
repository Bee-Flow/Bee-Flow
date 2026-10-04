/**
 * The organisation MCP library's admin operations (./service.js), run
 * against an in-memory world: the custom-integration store, the connection
 * store (connections + lend grants), the user store (org list, groups,
 * audit), the server-wide MCP store, the entitlement resolver, the MCP client
 * and the config store. Every call lands in `w.log` in order, so a test can
 * say both WHAT happened and that it happened before or after something else
 * (a key is tried before it is stored, access is checked before anything is
 * created or connected).
 *
 * No module mocking: every dependency is an entry on the seam object
 * ./deps.js, replaced per test and put back afterwards. The real definition
 * builder, validator, policy, tools-cache builder and tool normaliser run.
 *
 * Run: cd server && node --test core/customIntegrations/mcpLibrary/service.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');

const deps = require('./deps');
const service = require('./service');
const { getCatalogEntry } = require('./catalog');
const { HttpError } = require('../../http/errors');
const realClient = require('../customMcpClient');
const log = require('../../../telemetry/log');
const { makeSwaps } = require('../../../testUtils/swaps');

const ORG = 'org1';
const OTHER_ORG = 'org2';
const ADMIN = 'admin1';
const MEMBER = 'member1';
const KEY = 'ghp_SECRET_value_1234567890';
const NEW_KEY = 'ghp_NEW_secret_0987654321';
const GITHUB = getCatalogEntry('github');
const GITHUB_ORIGIN = 'https://api.githubcopilot.com';

const REMOTE_TOOLS = [
    { name: 'search_code', description: 'Search code.', inputSchema: { type: 'object', properties: { q: { type: 'string' } } }, annotations: { readOnlyHint: true } },
    { name: 'get_issue', description: 'Read an issue.', inputSchema: { type: 'object', properties: { n: { type: 'integer' } } }, annotations: { readOnlyHint: true } },
    { name: 'create_issue', description: 'Open an issue.', inputSchema: { type: 'object', properties: { title: { type: 'string' } } }, annotations: { readOnlyHint: false, destructiveHint: false } },
];

const clone = (x) => (x === undefined || x === null ? x : structuredClone(x));

const httpError = (status, code) => (err) => {
    assert.ok(err instanceof HttpError, `expected an HttpError, got ${err && err.name}: ${err && err.message}`);
    assert.strictEqual(err.status, status, `status of ${err.code}`);
    assert.strictEqual(err.code, code);
    return true;
};

// ── The in-memory world ─────────────────────────────────────────────

const ORIGINAL_DEPS = { ...deps };
const swaps = makeSwaps();
let w;

function makeWorld() {
    const world = {
        policy: { remote: 'official', allowedHosts: [] },
        builder: false,
        rows: new Map(),
        connections: new Map(),
        grants: [],
        orgLists: { [ORG]: ['gmail'], [OTHER_ORG]: ['custom:someone-else'] },
        groups: [
            { id: 'g1', name: 'Finance', organizationId: ORG, granted_capabilities: [] },
            { id: 'g2', name: 'Sales', organizationId: ORG, granted_capabilities: ['gmail'] },
            { id: 'gx', name: 'Elsewhere', organizationId: OTHER_ORG, granted_capabilities: [] },
        ],
        // What the remote server lists, and the keys it accepts (null: no key needed).
        remote: { tools: clone(REMOTE_TOOLS), keys: new Set([KEY, NEW_KEY]), error: null },
        mcpServers: [
            { id: 'srv1', name: 'Files', enabled: true, transport: 'stdio', tools_cache: [{ name: 'read' }] },
            { id: 'srv2', name: 'Paid', enabled: true, transport: 'http', tools_cache: [] },
            { id: 'off1', name: 'Off', enabled: false },
        ],
        orgAvailable: ['mcp:srv1'],
        log: [],
        audits: [],
        failOn: new Set(), // one-shot failures by call name
        seq: 0,
    };
    const rec = (what, ...args) => {
        world.log.push([what, ...args]);
        if (world.failOn.has(what)) {
            world.failOn.delete(what);
            throw new Error(`boom: ${what}`);
        }
    };
    const pub = (c) => { const { secret: _secret, ...rest } = c; return clone(rest); };
    const row = (id) => world.rows.get(id);

    world.store = {
        resolveOrgId: (o) => (o && String(o).trim()) || '__default_org__',
        createIntegration: async (p) => {
            rec('createIntegration', clone(p));
            const n = ++world.seq;
            const id = `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
            const r = {
                id, orgId: p.orgId, slug: `abcd${String(n).padStart(4, '0')}`, kind: p.kind, name: p.name,
                description: p.description || null, status: 'draft', definition: {}, definitionVersion: 0,
                activatedDefinition: null, toolsCache: [], allowWrites: false, lendMode: null,
                createdBy: p.createdBy, activatedBy: null, activatedAt: null, createdAt: '2026-10-01T00:00:00.000Z',
            };
            world.rows.set(id, r);
            return clone(r);
        },
        saveDefinition: async (id, definition, userId, opts) => {
            rec('saveDefinition', id, clone(definition), userId, clone(opts));
            const r = row(id);
            if (!r) return null;
            r.definition = clone(definition);
            r.definitionVersion++;
            return clone(r);
        },
        activate: async (id, p) => {
            rec('activate', id, clone(p));
            const r = row(id);
            if (!r) return null;
            Object.assign(r, {
                status: 'active', activatedDefinition: clone(p.definition || r.definition), toolsCache: clone(p.toolsCache),
                allowWrites: p.allowWrites === true, lendMode: p.lendMode, activatedBy: p.userId, activatedAt: '2026-10-01T00:00:01.000Z',
            });
            return clone(r);
        },
        deactivate: async (id) => { rec('deactivate', id); const r = row(id); if (!r) return false; r.status = 'disabled'; return true; },
        getById: async (id) => { rec('getById', id); return clone(row(id)) || null; },
        deleteIntegration: async (id) => {
            rec('deleteIntegration', id);
            const r = row(id);
            if (!r || r.status === 'active') return false; // the real store refuses an active row
            world.rows.delete(id);
            return true;
        },
        listForOrg: async (orgId) => [...world.rows.values()].filter(r => r.orgId === orgId).map(clone),
        listActiveForOrg: async (orgId) => [...world.rows.values()].filter(r => r.orgId === orgId && r.status === 'active').map(clone),
    };

    world.connStore = {
        listGrants: async ({ orgId }) => world.grants
            .filter(g => g.org_id === orgId && !g.revoked_at && world.connections.has(g.connection_id)) // JOIN on the connection
            .map(g => ({ ...clone(g), provider: world.connections.get(g.connection_id).provider })),
        getDefaultConnection: async (userId, provider) => {
            const c = [...world.connections.values()].find(x => x.ownerUserId === userId && x.provider === provider && x.isDefault);
            return c ? pub(c) : null;
        },
        listConnectionsForUser: async (userId, provider) => [...world.connections.values()]
            .filter(x => x.ownerUserId === userId && (!provider || x.provider === provider)).map(pub),
        getConnectionWithSecret: async (id) => clone(world.connections.get(id)) || null,
        createConnection: async (p) => {
            rec('createConnection', clone(p));
            const id = `conn-${++world.seq}`;
            const c = {
                id, ownerUserId: p.ownerUserId, orgId: p.orgId, provider: p.provider, label: p.label, kind: p.kind,
                secret: clone(p.secretObject), secretMeta: clone(p.secretMeta), isDefault: !!p.makeDefault, status: 'active',
            };
            world.connections.set(id, c);
            return pub(c);
        },
        updateConnectionSecret: async (id, secretObject, secretMeta) => {
            rec('updateConnectionSecret', id, clone(secretObject), clone(secretMeta));
            const c = world.connections.get(id);
            if (!c) return false;
            c.secret = clone(secretObject);
            if (secretMeta !== null && secretMeta !== undefined) c.secretMeta = clone(secretMeta);
            return true;
        },
        shareConnection: async (p) => {
            rec('shareConnection', clone(p));
            const c = world.connections.get(p.connectionId);
            const g = {
                id: `grant-${++world.seq}`, connection_id: p.connectionId, grantee_type: p.granteeType, grantee_id: p.granteeId,
                grantor_user_id: p.grantorUserId, org_id: c.orgId, revoked_at: null,
            };
            world.grants.push(g);
            return clone(g);
        },
        revokeGrant: async (id) => {
            rec('revokeGrant', id);
            const g = world.grants.find(x => x.id === id && !x.revoked_at);
            if (!g) return false;
            g.revoked_at = '2026-10-01T00:00:02.000Z';
            return true;
        },
        deleteConnectionsForProvider: async (p) => {
            rec('deleteConnectionsForProvider', clone(p));
            let n = 0;
            for (const [id, c] of world.connections) {
                if (c.provider === p.provider && c.orgId === p.orgId) { world.connections.delete(id); n++; }
            }
            return n;
        },
        deleteConnection: async (id) => { rec('deleteConnection', id); return world.connections.delete(id); },
    };

    world.userStore = {
        getUser: async (id) => ({ id, organizationId: ORG }),
        getAllGroups: async () => clone(world.groups),
        getOrgEnabledIntegrations: async (orgId) => [...(world.orgLists[orgId] || [])],
        setOrgEnabledIntegrations: async (orgId, list) => {
            rec('setOrgEnabledIntegrations', orgId, [...list]);
            world.orgLists[orgId] = [...list];
            return true;
        },
        updateGroup: async (id, patch) => {
            rec('updateGroup', id, clone(patch));
            const g = world.groups.find(x => x.id === id);
            if (!g) return false;
            g.granted_capabilities = [...patch.grantedCapabilities];
            return true;
        },
        logAccessAudit: async (...args) => { rec('logAccessAudit', ...clone(args)); world.audits.push(clone(args)); },
    };

    world.mcpStore = {
        listServers: async () => clone(world.mcpServers),
        getServer: async (id) => clone(world.mcpServers.find(s => s.id === id)) || null,
    };

    world.entitlements = {
        registry: { invalidateCustomIntegrationCache: (orgId) => { rec('invalidateCustomIntegrationCache', orgId); } },
        invalidateForOrg: async (orgId) => { rec('invalidateForOrg', orgId); },
        resolveEntitlements: async (args) => {
            rec('resolveEntitlements', { userId: args.userId, orgId: args.orgId });
            return { orgAvailable: { integration: [...world.orgAvailable] }, effective: { integration: [] } };
        },
    };

    world.mcpClient = {
        discoverTools: async (probe, { secretObject } = {}) => {
            rec('discoverTools', clone(probe), clone(secretObject));
            if (world.remote.error) throw world.remote.error;
            const mcp = probe.definition.mcp;
            if (mcp.authStyle !== 'none' && world.remote.keys) {
                const value = secretObject ? Object.values(secretObject)[0] : null;
                if (!value || !world.remote.keys.has(value)) {
                    throw new Error('Error POSTing to endpoint (HTTP 401): {"message":"Bad credentials"}');
                }
            }
            return realClient.normalizeAndFilterTools(clone(world.remote.tools), Array.isArray(mcp.toolAllowList) ? mcp.toolAllowList : null);
        },
        closeIntegration: async (id) => { rec('closeIntegration', id); },
        normalizeAndFilterTools: realClient.normalizeAndFilterTools,
    };

    world.configStore = { getConfig: async (key) => (key === 'mcp_org_policy' ? clone(world.policy) : null) };

    // Small readers for assertions.
    world.calls = (what) => world.log.filter(e => e[0] === what).map(e => e.slice(1));
    world.names = () => world.log.map(e => e[0]);
    world.indexOf = (what) => world.log.findIndex(e => e[0] === what);
    world.group = (id) => world.groups.find(g => g.id === id);
    world.providerConnections = (provider) => [...world.connections.values()].filter(c => c.provider === provider);
    world.reset = () => { world.log.length = 0; };
    return world;
}

beforeEach(() => {
    w = makeWorld();
    Object.assign(deps, {
        store: () => w.store,
        connStore: () => w.connStore,
        userStore: () => w.userStore,
        mcpStore: () => w.mcpStore,
        configStore: () => w.configStore,
        entitlements: () => w.entitlements,
        mcpClient: () => w.mcpClient,
        isBuilderEnabled: async () => w.builder,
    });
    // The rollback and validation paths warn; the assertions are on behaviour.
    swaps.swap(log, 'warn', () => {});
});
afterEach(() => {
    Object.assign(deps, ORIGINAL_DEPS);
    swaps.restore();
});

/** Install GitHub with the shared key; returns the shaped server and the stored row id. */
async function installGithub(input = {}) {
    const server = await service.install({
        orgId: ORG,
        actorUserId: ADMIN,
        input: { catalogId: 'github', credential: KEY, tools: ['search_code', 'get_issue'], access: { mode: 'everyone' }, ...input },
    });
    return { server, id: server.id, row: () => clone(w.rows.get(server.id)) };
}

// ── install ─────────────────────────────────────────────────────────

describe('install — shared key, everyone', () => {
    it('probes, creates, stores the key bound to the origin, activates the chosen tools, lends and grants', async () => {
        const server = await service.install({
            orgId: ORG,
            actorUserId: ADMIN,
            input: { catalogId: 'github', credential: `  ${KEY}  `, tools: ['search_code', 'get_issue'], access: { mode: 'everyone' } },
        });
        const id = server.id;
        const provider = `custom:${id}`;

        // The remote is tried with the key BEFORE anything exists.
        assert.ok(w.indexOf('discoverTools') >= 0 && w.indexOf('discoverTools') < w.indexOf('createIntegration'));
        const [[probe, probeSecret]] = w.calls('discoverTools');
        assert.strictEqual(probe.definition.mcp.url, GITHUB.url);
        assert.deepStrictEqual(probeSecret, { token: KEY }, 'the key is trimmed');

        assert.deepStrictEqual(w.calls('createIntegration'), [[{
            orgId: ORG, name: 'GitHub', kind: 'mcp_remote', createdBy: ADMIN, description: GITHUB.description,
        }]]);

        const [[savedId, definition, savedBy, saveOpts]] = w.calls('saveDefinition');
        assert.strictEqual(savedId, id);
        assert.strictEqual(savedBy, ADMIN);
        assert.strictEqual(definition.meta.source, 'mcp_library');
        assert.strictEqual(definition.meta.catalogId, 'github');
        assert.strictEqual(definition.mcp.url, GITHUB.url);
        assert.deepStrictEqual(definition.mcp.toolAllowList, ['search_code', 'get_issue']);
        assert.deepStrictEqual(definition.mcp.discoveredTools.map(t => t.name), ['search_code', 'get_issue', 'create_issue']);
        assert.strictEqual(saveOpts.lastValidation.ok, true);

        assert.deepStrictEqual(w.calls('createConnection'), [[{
            ownerUserId: ADMIN, orgId: ORG, provider, label: 'GitHub', kind: 'mcp',
            secretObject: { token: KEY },
            secretMeta: { boundOrigin: GITHUB_ORIGIN, fields: ['token'] },
            makeDefault: true, mirror: false,
        }]]);

        const [[activatedId, act]] = w.calls('activate');
        assert.strictEqual(activatedId, id);
        assert.deepStrictEqual(act.definition, definition);
        assert.strictEqual(act.allowWrites, false);
        assert.strictEqual(act.lendMode, 'org');
        assert.strictEqual(act.userId, ADMIN);
        const slug = w.rows.get(id).slug;
        assert.deepStrictEqual(act.toolsCache.map(t => t.function.name), [`cint_${slug}_search_code`, `cint_${slug}_get_issue`]);
        assert.deepStrictEqual(act.toolsCache.map(t => t._cint.rawName), ['search_code', 'get_issue'], 'only the chosen tools');

        const conn = w.providerConnections(provider)[0];
        assert.deepStrictEqual(w.calls('shareConnection'), [[{ connectionId: conn.id, grantorUserId: ADMIN, granteeType: 'org', granteeId: null }]]);
        assert.deepStrictEqual(w.orgLists[ORG], ['gmail', `custom:${id}`]);
        assert.deepStrictEqual(w.calls('updateGroup'), [], 'everyone touches no group');

        assert.deepStrictEqual(w.calls('invalidateCustomIntegrationCache'), [[ORG]]);
        assert.deepStrictEqual(w.calls('invalidateForOrg'), [[ORG]]);

        assert.deepStrictEqual(server.access, { mode: 'everyone', groupIds: [] });
        assert.strictEqual(server.credentialMode, 'shared');
        assert.strictEqual(server.status, 'active');
        assert.strictEqual(server.official, true);
        assert.strictEqual(server.blockedByPolicy, false);
        assert.strictEqual(server.catalogId, 'github');
        assert.strictEqual(server.host, 'api.githubcopilot.com');
        assert.strictEqual(server.enabledToolCount, 2);
        assert.deepStrictEqual(server.tools.map(t => [t.name, t.enabled, t.readOnly]), [
            ['search_code', true, true], ['get_issue', true, true], ['create_issue', false, false],
        ]);
    });

    it('writes one audit row, with names and counts and never the key', async () => {
        const { id, server } = await installGithub();
        assert.strictEqual(w.audits.length, 1);
        const [verb, entity, entityId, actor, before, after, orgId] = w.audits[0];
        assert.strictEqual(verb, 'mcp_library.install');
        assert.strictEqual(entity, 'custom_integration');
        assert.strictEqual(entityId, id);
        assert.strictEqual(actor, ADMIN);
        assert.strictEqual(before, null);
        assert.strictEqual(orgId, ORG);
        assert.deepStrictEqual(after, {
            name: 'GitHub', catalogId: 'github', host: 'api.githubcopilot.com', official: true,
            credentialMode: 'shared', toolCount: 2, access: 'everyone', groupCount: 0,
        });
        assert.ok(!JSON.stringify(w.audits).includes(KEY), 'no key in any audit argument');
        assert.ok(!JSON.stringify(server).includes(KEY), 'no key in the response');
    });

    it('every advertised tool is switched on when no tool list is given', async () => {
        const server = await service.install({ orgId: ORG, actorUserId: ADMIN, input: { catalogId: 'github', credential: KEY, access: { mode: 'everyone' } } });
        assert.strictEqual(server.enabledToolCount, 3);
        assert.deepStrictEqual(w.calls('activate')[0][1].toolsCache.map(t => t._cint.rawName), ['search_code', 'get_issue', 'create_issue']);
    });

    it('a name and description from the admin win over the catalogue', async () => {
        await installGithub({ name: '  Our GitHub  ', description: ' Repos only ' });
        const [[created]] = w.calls('createIntegration');
        assert.strictEqual(created.name, 'Our GitHub');
        assert.strictEqual(created.description, 'Repos only');
    });
});

describe('install — credential modes', () => {
    it('personal: the admin\'s key is stored as their own, nothing is lent', async () => {
        const { server, id } = await installGithub({ credentialMode: 'personal' });
        assert.strictEqual(w.calls('createConnection').length, 1);
        assert.strictEqual(w.calls('createConnection')[0][0].ownerUserId, ADMIN);
        assert.deepStrictEqual(w.calls('shareConnection'), []);
        assert.strictEqual(w.calls('activate')[0][1].lendMode, 'byo');
        assert.strictEqual(server.credentialMode, 'personal');
        assert.ok(w.orgLists[ORG].includes(`custom:${id}`));
    });

    it('personal without a key cannot prove the connection and creates nothing', async () => {
        await assert.rejects(installGithub({ credentialMode: 'personal', credential: undefined }), httpError(422, 'connect_auth_required'));
        assert.deepStrictEqual(w.calls('createIntegration'), []);
        assert.deepStrictEqual(w.calls('createConnection'), []);
    });

    it('shared without a key is refused before anything connects', async () => {
        await assert.rejects(installGithub({ credential: '   ' }), httpError(400, 'credential_required'));
        assert.deepStrictEqual(w.names(), []);
    });

    it('a key that is not text, or too long, is refused before anything connects', async () => {
        await assert.rejects(installGithub({ credential: 42 }), httpError(400, 'invalid_credential'));
        await assert.rejects(installGithub({ credential: 'k'.repeat(4097) }), httpError(400, 'invalid_credential'));
        assert.deepStrictEqual(w.names(), []);
    });

    it('a key the server refuses creates nothing', async () => {
        await assert.rejects(installGithub({ credential: 'wrong-key' }), httpError(422, 'connect_auth_failed'));
        assert.deepStrictEqual(w.calls('createIntegration'), []);
        assert.strictEqual(w.connections.size, 0);
    });

    it('a keyless server stores no connection, even when a key is sent', async () => {
        w.remote.keys = null;
        const server = await service.install({ orgId: ORG, actorUserId: ADMIN, input: { catalogId: 'context7', credential: 'unused-key', access: { mode: 'everyone' } } });
        assert.deepStrictEqual(w.calls('discoverTools')[0][1], null, 'probed without a secret');
        assert.deepStrictEqual(w.calls('createConnection'), []);
        assert.deepStrictEqual(w.calls('shareConnection'), []);
        assert.strictEqual(w.calls('activate')[0][1].lendMode, 'byo');
        assert.strictEqual(server.credentialMode, 'none');
        assert.strictEqual(server.authStyle, 'none');
    });
});

describe('install — access', () => {
    it('groups: only the chosen group of this org gets the capability, the org list does not', async () => {
        const { server, id } = await installGithub({ access: { mode: 'groups', groupIds: ['g1'] } });
        const capId = `custom:${id}`;
        assert.deepStrictEqual(w.calls('updateGroup'), [['g1', { grantedCapabilities: [capId] }]]);
        assert.deepStrictEqual(w.group('g2').granted_capabilities, ['gmail']);
        assert.deepStrictEqual(w.group('gx').granted_capabilities, []);
        assert.ok(!w.orgLists[ORG].includes(capId));
        assert.deepStrictEqual(server.access, { mode: 'groups', groupIds: ['g1'] });
        assert.strictEqual(w.audits[0][5].groupCount, 1);
    });

    it('a group of another organisation is refused BEFORE any probe or row', async () => {
        await assert.rejects(installGithub({ access: { mode: 'groups', groupIds: ['g1', 'gx'] } }), httpError(400, 'unknown_group'));
        assert.deepStrictEqual(w.calls('discoverTools'), [], 'no remote session');
        assert.deepStrictEqual(w.calls('createIntegration'), [], 'no row');
        assert.deepStrictEqual(w.calls('updateGroup'), []);
        assert.deepStrictEqual(w.calls('setOrgEnabledIntegrations'), []);
    });

    it('a group id that does not exist is refused the same way', async () => {
        await assert.rejects(installGithub({ access: { mode: 'groups', groupIds: ['nope'] } }), httpError(400, 'unknown_group'));
        assert.deepStrictEqual(w.calls('discoverTools'), []);
        assert.deepStrictEqual(w.calls('createIntegration'), []);
    });

    it('groups mode without a group is refused before any probe or row', async () => {
        for (const access of [{ mode: 'groups', groupIds: [] }, { mode: 'groups' }]) {
            await assert.rejects(installGithub({ access }), httpError(400, 'groups_required'));
        }
        assert.deepStrictEqual(w.calls('discoverTools'), []);
        assert.deepStrictEqual(w.calls('createIntegration'), []);
    });

    it('no access choice means everyone', async () => {
        const { id } = await installGithub({ access: undefined });
        assert.ok(w.orgLists[ORG].includes(`custom:${id}`));
    });
});

describe('install — policy and tools', () => {
    it('policy off refuses with 403 and touches nothing', async () => {
        w.policy = { remote: 'off' };
        await assert.rejects(installGithub(), httpError(403, 'policy_policy_off'));
        assert.deepStrictEqual(w.names(), []);
    });

    it('the official-only policy refuses a custom endpoint and a self-hosted entry', async () => {
        await assert.rejects(
            service.install({ orgId: ORG, actorUserId: ADMIN, input: { url: 'https://mcp.corp.example.org/mcp', auth: { style: 'none' } } }),
            httpError(403, 'policy_not_official'),
        );
        await assert.rejects(
            service.install({ orgId: ORG, actorUserId: ADMIN, input: { catalogId: 'openobserve', url: 'https://logs.corp.example.org/api/default/mcp', credential: KEY } }),
            httpError(403, 'policy_not_official'),
        );
        assert.deepStrictEqual(w.names(), []);
    });

    it('plain http is refused under any policy', async () => {
        w.policy = { remote: 'any' };
        await assert.rejects(
            service.install({ orgId: ORG, actorUserId: ADMIN, input: { url: 'http://mcp.corp.example.org/mcp' } }),
            httpError(403, 'policy_not_https'),
        );
        assert.deepStrictEqual(w.names(), []);
    });

    it('an allow-listed host installs a self-hosted entry with the admin\'s url', async () => {
        w.policy = { remote: 'allowlist', allowedHosts: ['*.corp.example.org'] };
        const server = await service.install({
            orgId: ORG, actorUserId: ADMIN,
            input: { catalogId: 'openobserve', url: 'https://logs.corp.example.org/api/default/mcp', credential: KEY, tools: ['search_code'] },
        });
        assert.strictEqual(server.url, 'https://logs.corp.example.org/api/default/mcp');
        assert.strictEqual(server.official, false);
        assert.strictEqual(w.calls('createConnection')[0][0].secretMeta.boundOrigin, 'https://logs.corp.example.org');
        assert.deepStrictEqual(w.calls('createConnection')[0][0].secretObject, { authorization: KEY });
    });

    it('a tool the server does not offer is refused before a row exists', async () => {
        await assert.rejects(installGithub({ tools: ['search_code', 'delete_repo'] }), httpError(400, 'unknown_tool'));
        assert.strictEqual(w.calls('discoverTools').length, 1, 'the list comes from the server');
        assert.deepStrictEqual(w.calls('createIntegration'), []);
        assert.deepStrictEqual(w.calls('createConnection'), []);
    });

    it('no tool switched on is refused before a row exists', async () => {
        await assert.rejects(installGithub({ tools: [] }), httpError(400, 'no_tools_selected'));
        assert.deepStrictEqual(w.calls('createIntegration'), []);
    });

    it('a server that offers no tools is refused before a row exists', async () => {
        w.remote.tools = [];
        await assert.rejects(installGithub({ tools: undefined }), httpError(422, 'no_tools'));
        assert.deepStrictEqual(w.calls('createIntegration'), []);
    });
});

describe('install — rollback', () => {
    async function assertNothingLeft(id) {
        const provider = `custom:${id}`;
        assert.strictEqual(w.rows.size, 0, 'the row is gone');
        assert.deepStrictEqual(w.providerConnections(provider), [], 'no connection is left');
        assert.ok(!w.orgLists[ORG].includes(provider), 'no org grant is left');
        for (const g of w.groups) assert.ok(!g.granted_capabilities.includes(provider), `no grant left on ${g.id}`);
        assert.deepStrictEqual(w.calls('deactivate'), [[id]]);
        assert.deepStrictEqual(w.calls('deleteConnectionsForProvider'), [[{ provider, orgId: ORG }]]);
        assert.deepStrictEqual(w.calls('deleteIntegration'), [[id]]);
        assert.ok(w.calls('closeIntegration').some(([x]) => x === id));
        assert.ok(w.indexOf('deactivate') < w.indexOf('deleteIntegration'), 'deactivated first: the store refuses to delete an active row');
    }

    it('a failure after the row exists removes everything and rethrows the original error', async () => {
        w.failOn.add('shareConnection');
        await assert.rejects(installGithub(), /boom: shareConnection/);
        const [[created]] = w.calls('createIntegration');
        assert.ok(created);
        const id = w.calls('saveDefinition')[0][0];
        assert.ok(w.calls('createConnection').length === 1, 'the key had been stored');
        await assertNothingLeft(id);
        assert.deepStrictEqual(w.audits, [], 'no install audit for an install that did not happen');
    });

    it('a failure while granting a group also removes everything', async () => {
        w.failOn.add('updateGroup');
        await assert.rejects(installGithub({ access: { mode: 'groups', groupIds: ['g1'] } }), /boom: updateGroup/);
        await assertNothingLeft(w.calls('saveDefinition')[0][0]);
    });

    it('a server whose tool names smuggle a credential reference is refused and leaves nothing', async () => {
        w.remote.tools = [{ name: 'leak_{{credential.token}}', description: 'x', inputSchema: { type: 'object', properties: {} } }];
        await assert.rejects(installGithub({ tools: undefined }), httpError(422, 'invalid_server'));
        assert.deepStrictEqual(w.calls('saveDefinition'), [], 'the refused definition is never saved');
        assert.deepStrictEqual(w.calls('createConnection'), [], 'no key stored for it');
        assert.strictEqual(w.rows.size, 0);
        assert.strictEqual(w.calls('deleteIntegration').length, 1);
    });

    it('a rollback that fails itself still surfaces the original error', async () => {
        w.failOn.add('activate');
        w.failOn.add('deleteConnectionsForProvider');
        await assert.rejects(installGithub(), /boom: activate/);
    });
});

// ── update ──────────────────────────────────────────────────────────

describe('update', () => {
    it('new tools on a running server: re-discovers with the allow-list and the shared key, then re-activates', async () => {
        const { id, row } = await installGithub();
        w.reset();
        const server = await service.update({ orgId: ORG, row: row(), actorUserId: ADMIN, patch: { tools: ['get_issue', 'create_issue'] } });

        const [[probe, secret]] = w.calls('discoverTools');
        assert.deepStrictEqual(probe.definition.mcp.toolAllowList, ['get_issue', 'create_issue']);
        assert.deepStrictEqual(secret, { token: KEY }, 'the lent key is used');
        assert.deepStrictEqual(w.calls('saveDefinition')[0][1].mcp.toolAllowList, ['get_issue', 'create_issue']);
        const [[, act]] = w.calls('activate');
        assert.deepStrictEqual(act.toolsCache.map(t => t._cint.rawName), ['get_issue', 'create_issue']);
        assert.strictEqual(act.allowWrites, false);
        assert.strictEqual(act.lendMode, 'org');
        assert.deepStrictEqual(w.calls('closeIntegration'), [[id]], 'pooled sessions with the old tool set are closed');
        assert.ok(w.indexOf('discoverTools') < w.indexOf('saveDefinition'), 'checked against the server before saving');
        assert.strictEqual(server.enabledToolCount, 2);
        assert.strictEqual(server.status, 'active');
        assert.strictEqual(w.audits.at(-1)[0], 'mcp_library.update');
        assert.deepStrictEqual(w.audits.at(-1)[5], { status: 'active', toolCount: 2 });
    });

    it('an unknown tool is refused and nothing changes', async () => {
        const { row } = await installGithub();
        w.reset();
        await assert.rejects(service.update({ orgId: ORG, row: row(), actorUserId: ADMIN, patch: { tools: ['nope'] } }), httpError(400, 'unknown_tool'));
        await assert.rejects(service.update({ orgId: ORG, row: row(), actorUserId: ADMIN, patch: { tools: [] } }), httpError(400, 'no_tools_selected'));
        assert.deepStrictEqual(w.names(), []);
    });

    it('new tools on a switched-off server are saved as the draft only', async () => {
        const { row } = await installGithub();
        await service.update({ orgId: ORG, row: row(), actorUserId: ADMIN, patch: { enabled: false } });
        w.reset();
        const server = await service.update({ orgId: ORG, row: row(), actorUserId: ADMIN, patch: { tools: ['create_issue'] } });
        assert.deepStrictEqual(w.calls('discoverTools'), []);
        assert.deepStrictEqual(w.calls('activate'), []);
        assert.strictEqual(w.calls('saveDefinition').length, 1);
        assert.deepStrictEqual(row().activatedDefinition.mcp.toolAllowList, ['search_code', 'get_issue'], 'what ran is untouched');
        assert.strictEqual(server.status, 'disabled');
        assert.strictEqual(server.enabledToolCount, 1, 'the admin sees the saved choice');
    });

    it('new tools on a running server are refused when the policy no longer allows it', async () => {
        const { row } = await installGithub();
        w.policy = { remote: 'off' };
        w.reset();
        await assert.rejects(service.update({ orgId: ORG, row: row(), actorUserId: ADMIN, patch: { tools: ['get_issue'] } }), httpError(403, 'policy_policy_off'));
        assert.deepStrictEqual(w.calls('discoverTools'), []);
        assert.deepStrictEqual(w.calls('saveDefinition'), []);
    });

    it('enabled:false deactivates and closes the pooled sessions', async () => {
        const { id, row } = await installGithub();
        w.reset();
        const server = await service.update({ orgId: ORG, row: row(), actorUserId: ADMIN, patch: { enabled: false } });
        assert.deepStrictEqual(w.calls('deactivate'), [[id]]);
        assert.deepStrictEqual(w.calls('closeIntegration'), [[id]]);
        assert.strictEqual(server.status, 'disabled');
        assert.strictEqual(w.rows.get(id).status, 'disabled');
    });

    it('enabled:true re-activates through the server, under the policy', async () => {
        const { id, row } = await installGithub();
        await service.update({ orgId: ORG, row: row(), actorUserId: ADMIN, patch: { enabled: false } });

        w.policy = { remote: 'off' };
        await assert.rejects(service.update({ orgId: ORG, row: row(), actorUserId: ADMIN, patch: { enabled: true } }), httpError(403, 'policy_policy_off'));
        assert.strictEqual(w.rows.get(id).status, 'disabled');

        w.policy = { remote: 'official' };
        w.reset();
        const server = await service.update({ orgId: ORG, row: row(), actorUserId: ADMIN, patch: { enabled: true } });
        assert.strictEqual(w.calls('discoverTools').length, 1);
        assert.strictEqual(w.calls('activate').length, 1);
        assert.strictEqual(server.status, 'active');
    });

    it("credentialMode 'personal' stops lending the key; the admin keeps it", async () => {
        const { id, row } = await installGithub();
        const [grant] = w.grants;
        w.reset();
        const server = await service.update({ orgId: ORG, row: row(), actorUserId: ADMIN, patch: { credentialMode: 'personal' } });
        assert.deepStrictEqual(w.calls('revokeGrant'), [[grant.id]]);
        assert.deepStrictEqual(w.calls('closeIntegration'), [[id]]);
        assert.strictEqual(server.credentialMode, 'personal');
        assert.strictEqual(w.providerConnections(`custom:${id}`).length, 1, 'the key itself stays');
        assert.deepStrictEqual(w.calls('deleteConnection'), []);
    });

    it("credentialMode 'personal' on a server that lends nothing changes nothing", async () => {
        const { row } = await installGithub({ credentialMode: 'personal' });
        w.reset();
        await service.update({ orgId: ORG, row: row(), actorUserId: ADMIN, patch: { credentialMode: 'personal' } });
        assert.deepStrictEqual(w.calls('revokeGrant'), []);
    });

    it('access: groups takes the server off the org list, everyone puts it back and clears the groups', async () => {
        const { id, row } = await installGithub();
        const capId = `custom:${id}`;
        let server = await service.update({ orgId: ORG, row: row(), actorUserId: ADMIN, patch: { access: { mode: 'groups', groupIds: ['g1', 'g2'] } } });
        assert.ok(!w.orgLists[ORG].includes(capId));
        assert.deepStrictEqual(w.group('g1').granted_capabilities, [capId]);
        assert.deepStrictEqual(w.group('g2').granted_capabilities, ['gmail', capId]);
        assert.deepStrictEqual(server.access, { mode: 'groups', groupIds: ['g1', 'g2'] });

        server = await service.update({ orgId: ORG, row: row(), actorUserId: ADMIN, patch: { access: { mode: 'everyone' } } });
        assert.ok(w.orgLists[ORG].includes(capId));
        assert.deepStrictEqual(w.group('g1').granted_capabilities, []);
        assert.deepStrictEqual(w.group('g2').granted_capabilities, ['gmail']);
        assert.deepStrictEqual(server.access, { mode: 'everyone', groupIds: [] });
    });

    it('access naming another organisation\'s group is refused and nothing is written', async () => {
        const { row } = await installGithub();
        w.reset();
        await assert.rejects(service.update({ orgId: ORG, row: row(), actorUserId: ADMIN, patch: { access: { mode: 'groups', groupIds: ['gx'] } } }), httpError(400, 'unknown_group'));
        assert.deepStrictEqual(w.calls('setOrgEnabledIntegrations'), []);
        assert.deepStrictEqual(w.calls('updateGroup'), []);
    });
});

// ── refresh ─────────────────────────────────────────────────────────

describe('refresh', () => {
    it('keeps the known tools\' state, leaves new tools OFF and reports them', async () => {
        const { id, row } = await installGithub({ tools: ['search_code'] });
        w.remote.tools = [...clone(REMOTE_TOOLS), { name: 'merge_pr', description: 'Merge.', inputSchema: { type: 'object', properties: {} } }];
        w.reset();
        const out = await service.refresh({ orgId: ORG, row: row(), actorUserId: ADMIN });

        assert.deepStrictEqual(out.newTools, ['merge_pr']);
        const saved = w.calls('saveDefinition')[0][1];
        assert.deepStrictEqual(saved.mcp.discoveredTools.map(t => t.name), ['search_code', 'get_issue', 'create_issue', 'merge_pr']);
        assert.deepStrictEqual(saved.mcp.toolAllowList, ['search_code'], 'nothing new is switched on by the server');
        assert.deepStrictEqual(w.calls('activate')[0][1].toolsCache.map(t => t._cint.rawName), ['search_code']);
        assert.deepStrictEqual(out.server.tools.map(t => [t.name, t.enabled]), [
            ['search_code', true], ['get_issue', false], ['create_issue', false], ['merge_pr', false],
        ]);
        assert.deepStrictEqual(w.calls('discoverTools')[0][1], { token: KEY }, 'refreshed with the lent key');
        assert.deepStrictEqual(w.audits.at(-1).slice(0, 3), ['mcp_library.refresh', 'custom_integration', id]);
        assert.deepStrictEqual(w.audits.at(-1)[5], { toolCount: 4, newToolCount: 1 });
    });

    it('a server that dropped every switched-on tool is switched off, not left running', async () => {
        const { id, row } = await installGithub({ tools: ['search_code'] });
        w.remote.tools = clone(REMOTE_TOOLS).filter(t => t.name !== 'search_code');
        w.reset();
        const out = await service.refresh({ orgId: ORG, row: row(), actorUserId: ADMIN });
        assert.deepStrictEqual(w.calls('activate'), []);
        assert.deepStrictEqual(w.calls('deactivate'), [[id]]);
        assert.deepStrictEqual(w.calls('closeIntegration'), [[id]]);
        assert.strictEqual(out.server.status, 'disabled');
        assert.deepStrictEqual(out.newTools, []);
    });

    it('is refused when the policy no longer allows the endpoint, before connecting', async () => {
        const { row } = await installGithub();
        w.policy = { remote: 'off' };
        w.reset();
        await assert.rejects(service.refresh({ orgId: ORG, row: row(), actorUserId: ADMIN }), httpError(403, 'policy_policy_off'));
        assert.deepStrictEqual(w.calls('discoverTools'), []);
    });
});

// ── setSharedCredential ─────────────────────────────────────────────

describe('setSharedCredential', () => {
    it('tries the new key first, then replaces the lent key in place and closes the pool', async () => {
        const { id, row } = await installGithub();
        const [grant] = w.grants;
        w.reset();
        const out = await service.setSharedCredential({ orgId: ORG, row: row(), actorUserId: ADMIN, value: ` ${NEW_KEY} ` });
        assert.deepStrictEqual(out, { ok: true });
        assert.deepStrictEqual(w.calls('discoverTools')[0][1], { token: NEW_KEY });
        assert.deepStrictEqual(w.calls('updateConnectionSecret'), [[grant.connection_id, { token: NEW_KEY }, { boundOrigin: GITHUB_ORIGIN, fields: ['token'] }]]);
        assert.ok(w.indexOf('discoverTools') < w.indexOf('updateConnectionSecret'));
        assert.deepStrictEqual(w.calls('closeIntegration'), [[id]]);
        assert.deepStrictEqual(w.calls('createConnection'), []);
        assert.deepStrictEqual(w.calls('shareConnection'), []);
        assert.strictEqual(w.connections.get(grant.connection_id).secret.token, NEW_KEY);
        assert.strictEqual(w.audits.at(-1)[0], 'mcp_library.credential_set');
        assert.ok(!JSON.stringify(w.audits).includes(NEW_KEY));
        assert.ok(!JSON.stringify(w.audits).includes(KEY));
    });

    it('a key the server refuses is not stored', async () => {
        const { row } = await installGithub();
        const [grant] = w.grants;
        w.reset();
        await assert.rejects(service.setSharedCredential({ orgId: ORG, row: row(), actorUserId: ADMIN, value: 'refused-key' }), httpError(422, 'connect_auth_failed'));
        assert.deepStrictEqual(w.calls('updateConnectionSecret'), []);
        assert.deepStrictEqual(w.calls('createConnection'), []);
        assert.deepStrictEqual(w.calls('shareConnection'), []);
        assert.deepStrictEqual(w.calls('closeIntegration'), []);
        assert.strictEqual(w.connections.get(grant.connection_id).secret.token, KEY);
    });

    it('on a personal-mode server it replaces the admin\'s key and starts lending it', async () => {
        const { row } = await installGithub({ credentialMode: 'personal' });
        const ownId = w.providerConnections(`custom:${row().id}`)[0].id;
        w.reset();
        await service.setSharedCredential({ orgId: ORG, row: row(), actorUserId: ADMIN, value: NEW_KEY });
        assert.deepStrictEqual(w.calls('updateConnectionSecret').map(c => c[0]), [ownId]);
        assert.deepStrictEqual(w.calls('shareConnection'), [[{ connectionId: ownId, grantorUserId: ADMIN, granteeType: 'org', granteeId: null }]]);
    });

    it('a keyless server has no key to set', async () => {
        w.remote.keys = null;
        const server = await service.install({ orgId: ORG, actorUserId: ADMIN, input: { catalogId: 'context7' } });
        await assert.rejects(service.setSharedCredential({ orgId: ORG, row: clone(w.rows.get(server.id)), actorUserId: ADMIN, value: KEY }), httpError(409, 'no_credential'));
    });

    it('an empty or malformed key is refused before connecting', async () => {
        const { row } = await installGithub();
        w.reset();
        await assert.rejects(service.setSharedCredential({ orgId: ORG, row: row(), actorUserId: ADMIN, value: '  ' }), httpError(400, 'credential_required'));
        await assert.rejects(service.setSharedCredential({ orgId: ORG, row: row(), actorUserId: ADMIN, value: 7 }), httpError(400, 'invalid_credential'));
        assert.deepStrictEqual(w.calls('discoverTools'), []);
    });

    it('does not connect to an endpoint the policy now refuses', async () => {
        const { row } = await installGithub();
        w.policy = { remote: 'off' };
        w.reset();
        await assert.rejects(service.setSharedCredential({ orgId: ORG, row: row(), actorUserId: ADMIN, value: NEW_KEY }), httpError(403, 'policy_policy_off'));
        assert.deepStrictEqual(w.calls('discoverTools'), []);
    });
});

// ── uninstall ───────────────────────────────────────────────────────

describe('uninstall', () => {
    it('revokes access from the org list AND every group, deletes every key of the server, deletes the row', async () => {
        const { id, row } = await installGithub();
        const capId = `custom:${id}`;
        w.group('g2').granted_capabilities.push(capId);
        // A member's own key for the same server, and an unrelated connection.
        w.connections.set('member-conn', { id: 'member-conn', ownerUserId: MEMBER, orgId: ORG, provider: capId, isDefault: true, secret: { token: 'm' } });
        w.connections.set('other-conn', { id: 'other-conn', ownerUserId: MEMBER, orgId: ORG, provider: 'custom:other', isDefault: true, secret: { token: 'o' } });
        const before = clone(w.rows.get(id));
        w.reset();

        assert.deepStrictEqual(await service.uninstall({ orgId: ORG, row: row(), actorUserId: ADMIN }), { removed: true });

        assert.ok(!w.orgLists[ORG].includes(capId));
        assert.ok(w.orgLists[ORG].includes('gmail'), 'other grants stay');
        assert.deepStrictEqual(w.group('g2').granted_capabilities, ['gmail']);
        assert.deepStrictEqual(w.calls('deleteConnectionsForProvider'), [[{ provider: capId, orgId: ORG }]]);
        assert.deepStrictEqual(w.providerConnections(capId), []);
        assert.ok(w.connections.has('other-conn'), 'another server\'s key is untouched');
        assert.strictEqual(w.rows.has(id), false);
        assert.deepStrictEqual(w.calls('closeIntegration'), [[id]]);
        assert.ok(w.indexOf('deactivate') < w.indexOf('deleteIntegration'));
        assert.deepStrictEqual(w.audits.at(-1), ['mcp_library.uninstall', 'custom_integration', id, ADMIN, { name: before.name, host: 'api.githubcopilot.com', status: 'active' }, null, ORG]);
    });
});

// ── server-wide servers ─────────────────────────────────────────────

describe('setServerWideAccess', () => {
    it('switches an available server on for everyone', async () => {
        const out = await service.setServerWideAccess({ orgId: ORG, serverId: 'srv1', actorUserId: ADMIN, access: { mode: 'everyone' } });
        assert.deepStrictEqual(out, { mode: 'everyone', groupIds: [] });
        assert.ok(w.orgLists[ORG].includes('mcp:srv1'));
        assert.deepStrictEqual(w.calls('resolveEntitlements'), [[{ userId: null, orgId: ORG }]]);
        assert.deepStrictEqual(w.audits.at(-1), ['mcp_library.server_wide_access', 'mcp_server', 'srv1', ADMIN, null, { access: 'everyone', groupCount: 0 }, ORG]);
    });

    it('refuses (403) a server outside the organisation\'s access, and writes nothing', async () => {
        await assert.rejects(
            service.setServerWideAccess({ orgId: ORG, serverId: 'srv2', actorUserId: ADMIN, access: { mode: 'everyone' } }),
            httpError(403, 'not_available'),
        );
        await assert.rejects(
            service.setServerWideAccess({ orgId: ORG, serverId: 'srv2', actorUserId: ADMIN, access: { mode: 'groups', groupIds: ['g1'] } }),
            httpError(403, 'not_available'),
        );
        assert.deepStrictEqual(w.calls('setOrgEnabledIntegrations'), []);
        assert.deepStrictEqual(w.calls('updateGroup'), []);
    });

    it('groups, then nobody: toggles mcp:<id> on the group and off everywhere', async () => {
        await service.setServerWideAccess({ orgId: ORG, serverId: 'srv1', actorUserId: ADMIN, access: { mode: 'groups', groupIds: ['g1'] } });
        assert.deepStrictEqual(w.group('g1').granted_capabilities, ['mcp:srv1']);
        assert.ok(!w.orgLists[ORG].includes('mcp:srv1'));

        await service.setServerWideAccess({ orgId: ORG, serverId: 'srv1', actorUserId: ADMIN, access: { mode: 'everyone' } });
        assert.ok(w.orgLists[ORG].includes('mcp:srv1'));
        assert.deepStrictEqual(w.group('g1').granted_capabilities, [], 'everyone clears the group grant');

        w.group('g2').granted_capabilities.push('mcp:srv1');
        const out = await service.setServerWideAccess({ orgId: ORG, serverId: 'srv1', actorUserId: ADMIN, access: { mode: 'nobody' } });
        assert.deepStrictEqual(out, { mode: 'nobody', groupIds: [] });
        assert.ok(!w.orgLists[ORG].includes('mcp:srv1'));
        assert.deepStrictEqual(w.group('g2').granted_capabilities, ['gmail']);
    });

    it('switching off needs no availability check', async () => {
        w.orgLists[ORG].push('mcp:srv2');
        w.reset();
        await service.setServerWideAccess({ orgId: ORG, serverId: 'srv2', actorUserId: ADMIN, access: { mode: 'nobody' } });
        assert.deepStrictEqual(w.calls('resolveEntitlements'), []);
        assert.ok(!w.orgLists[ORG].includes('mcp:srv2'));
    });

    it('an unknown or disabled server is a 404', async () => {
        for (const serverId of ['nope', 'off1']) {
            await assert.rejects(
                service.setServerWideAccess({ orgId: ORG, serverId, actorUserId: ADMIN, access: { mode: 'everyone' } }),
                httpError(404, 'server_not_found'),
            );
        }
    });

    it('a group of another organisation is refused', async () => {
        await assert.rejects(
            service.setServerWideAccess({ orgId: ORG, serverId: 'srv1', actorUserId: ADMIN, access: { mode: 'groups', groupIds: ['gx'] } }),
            httpError(400, 'unknown_group'),
        );
        assert.deepStrictEqual(w.calls('updateGroup'), []);
    });
});

// ── reads ───────────────────────────────────────────────────────────

describe('loadOrgRow', () => {
    function put(row) { w.rows.set(row.id, row); }
    const libDef = { specVersion: 1, meta: { source: 'mcp_library' }, mcp: { url: GITHUB.url, authStyle: 'none' } };

    it('returns this organisation\'s library row', async () => {
        put({ id: 'lib-own', orgId: ORG, kind: 'mcp_remote', status: 'active', definition: libDef, activatedDefinition: libDef });
        const row = await service.loadOrgRow(ORG, 'lib-own');
        assert.strictEqual(row.id, 'lib-own');
    });

    it('is null for another organisation\'s library row, a builder row, a REST row and a missing row', async () => {
        put({ id: 'lib-other', orgId: OTHER_ORG, kind: 'mcp_remote', status: 'active', definition: libDef, activatedDefinition: libDef });
        const builderDef = { specVersion: 1, mcp: { url: GITHUB.url, authStyle: 'none' } };
        put({ id: 'builder-own', orgId: ORG, kind: 'mcp_remote', status: 'active', definition: builderDef, activatedDefinition: builderDef });
        put({ id: 'rest-own', orgId: ORG, kind: 'rest', status: 'active', definition: { meta: { source: 'mcp_library' } }, activatedDefinition: null });
        assert.strictEqual(await service.loadOrgRow(ORG, 'lib-other'), null);
        assert.strictEqual(await service.loadOrgRow(ORG, 'builder-own'), null);
        assert.strictEqual(await service.loadOrgRow(ORG, 'rest-own'), null);
        assert.strictEqual(await service.loadOrgRow(ORG, 'missing'), null);
    });

    it('is null when the store fails', async () => {
        w.store.getById = async () => { throw new Error('db down'); };
        assert.strictEqual(await service.loadOrgRow(ORG, 'x'), null);
    });
});

describe('getLibrary', () => {
    it('lists only this organisation\'s library rows, flags what the policy now blocks, and the catalogue as allowed', async () => {
        const { id } = await installGithub();
        const customDef = { specVersion: 1, meta: { source: 'mcp_library' }, mcp: { url: 'https://mcp.corp.example.org/mcp', authStyle: 'none', discoveredTools: [{ name: 't', description: '' }] } };
        w.rows.set('lib-custom', { id: 'lib-custom', orgId: ORG, kind: 'mcp_remote', status: 'active', name: 'Corp', definition: customDef, activatedDefinition: customDef });
        w.rows.set('lib-other', { id: 'lib-other', orgId: OTHER_ORG, kind: 'mcp_remote', status: 'active', name: 'Theirs', definition: customDef, activatedDefinition: customDef });
        const builderDef = { specVersion: 1, mcp: { url: GITHUB.url, authStyle: 'none' } };
        w.rows.set('builder', { id: 'builder', orgId: ORG, kind: 'mcp_remote', status: 'active', name: 'Built', definition: builderDef, activatedDefinition: builderDef });

        const lib = await service.getLibrary({ orgId: ORG, isServerAdmin: false });

        assert.deepStrictEqual(lib.installed.map(s => s.id).sort(), [id, 'lib-custom'].sort());
        const custom = lib.installed.find(s => s.id === 'lib-custom');
        assert.strictEqual(custom.blockedByPolicy, true);
        assert.strictEqual(custom.blockedReason, 'not_official');
        assert.strictEqual(custom.credentialMode, 'none');
        assert.strictEqual(lib.installed.find(s => s.id === id).blockedByPolicy, false);

        assert.deepStrictEqual(lib.policy, { remote: 'official', allowsCustomUrls: false, allowedHosts: [] });
        assert.strictEqual(lib.isServerAdmin, false);
        const github = lib.catalog.find(e => e.id === 'github');
        assert.strictEqual(github.allowed, true);
        assert.deepStrictEqual(github.installedIds, [id]);
        assert.strictEqual(lib.catalog.find(e => e.id === 'openobserve').allowed, false, 'self-hosted needs custom urls');
        assert.deepStrictEqual(lib.groups, [{ id: 'g1', name: 'Finance' }, { id: 'g2', name: 'Sales' }]);

        assert.deepStrictEqual(lib.serverWide.map(s => [s.id, s.available, s.runsOn]), [['srv1', true, 'server'], ['srv2', false, 'remote']]);
        assert.ok(!JSON.stringify(lib).includes(KEY), 'no key in the library payload');
    });

    it('with policy off nothing in the catalogue is installable, and allowed hosts show only in allowlist mode', async () => {
        w.policy = { remote: 'off', allowedHosts: ['a.example.com'] };
        let lib = await service.getLibrary({ orgId: ORG });
        assert.ok(lib.catalog.every(e => e.allowed === false));
        assert.deepStrictEqual(lib.policy.allowedHosts, []);

        w.policy = { remote: 'allowlist', allowedHosts: ['a.example.com'] };
        lib = await service.getLibrary({ orgId: ORG, isServerAdmin: true });
        assert.ok(lib.catalog.every(e => e.allowed === true));
        assert.deepStrictEqual(lib.policy, { remote: 'allowlist', allowsCustomUrls: true, allowedHosts: ['a.example.com'] });
        assert.strictEqual(lib.isServerAdmin, true);
    });
});

describe('probe', () => {
    it('connects to the pinned catalogue endpoint and stores nothing', async () => {
        const out = await service.probe({ catalogId: 'github', url: 'https://evil.example.com/mcp', credential: KEY });
        assert.strictEqual(out.url, GITHUB.url);
        assert.deepStrictEqual(out.tools.map(t => t.name), ['search_code', 'get_issue', 'create_issue']);
        assert.ok(out.tools.every(t => !('inputSchema' in t)), 'slim records only');
        assert.deepStrictEqual(out.warnings, []);
        assert.deepStrictEqual(w.names(), ['discoverTools']);
    });

    it('is refused by the policy before it connects', async () => {
        w.policy = { remote: 'off' };
        await assert.rejects(service.probe({ catalogId: 'github', credential: KEY }), httpError(403, 'policy_policy_off'));
        await assert.rejects(service.probe({ url: 'https://mcp.corp.example.org/mcp' }), httpError(403, 'policy_policy_off'));
        assert.deepStrictEqual(w.names(), []);
    });
});
