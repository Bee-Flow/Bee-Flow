/**
 * The member side of the organisation MCP library (./members.js): which
 * servers a person may add their own key for, and their own key.
 *
 * What this file pins:
 *   - a member only sees RUNNING library rows of their OWN organisation that
 *     they are entitled to and that take a key (not a builder row, not a
 *     server the policy now blocks, not a keyless one);
 *   - saving a key tries it against the server first and stores it as the
 *     member's own connection, bound to the server's origin;
 *   - removing "my key" never takes the organisation's shared key with it.
 *
 * No module mocking: every dependency is an entry on the seam object
 * ./deps.js, replaced per test and put back afterwards.
 *
 * Run: cd server && node --test core/customIntegrations/mcpLibrary/members.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');

const deps = require('./deps');
const members = require('./members');
const { getCatalogEntry } = require('./catalog');
const { HttpError } = require('../../http/errors');

const ORG = 'org1';
const OTHER_ORG = 'org2';
const ADMIN = 'admin1';
const MEMBER = 'member1';
const ADMIN_KEY = 'ghp_ADMIN_shared_key_123456';
const MEMBER_KEY = 'ghp_MEMBER_own_key_654321';
const GITHUB = getCatalogEntry('github');

const clone = (x) => (x === undefined || x === null ? x : structuredClone(x));
const httpError = (status, code) => (err) => {
    assert.ok(err instanceof HttpError, `expected an HttpError, got ${err && err.name}: ${err && err.message}`);
    assert.strictEqual(err.status, status);
    assert.strictEqual(err.code, code);
    return true;
};

const bearerMcp = (url, extra = {}) => ({
    url, authStyle: 'bearer', valueTemplate: 'Bearer {{credential.token}}',
    credentials: [{ key: 'token', label: 'Personal access token' }], toolAllowList: ['search'],
    discoveredTools: [{ name: 'search', description: '', readOnly: true, destructive: null }], ...extra,
});
const libDef = (mcp, catalogId = null) => ({ specVersion: 1, meta: catalogId ? { source: 'mcp_library', catalogId } : { source: 'mcp_library' }, mcp });

function row(id, { orgId = ORG, status = 'active', def, name = id } = {}) {
    return { id, orgId, slug: 'abcd1234', kind: 'mcp_remote', name, description: `${name} description`, status, definition: def, activatedDefinition: def };
}

// The cast of rows; all `active` unless said otherwise.
const ROWS = [
    row('lib-github', { def: libDef(bearerMcp(GITHUB.url), 'github'), name: 'GitHub' }),                               // shown
    row('lib-keyless', { def: libDef({ url: 'https://mcp.context7.com/mcp', authStyle: 'none' }, 'context7') }),       // no key → hidden
    row('lib-not-entitled', { def: libDef(bearerMcp('https://mcp.linear.app/mcp'), 'linear') }),                       // not entitled → hidden
    row('lib-blocked', { def: libDef(bearerMcp('https://mcp.corp.example.org/mcp')) }),                                // policy blocks → hidden
    row('builder-keyed', { def: { specVersion: 1, mcp: bearerMcp('https://mcp.linear.app/mcp') } }),                  // builder row → hidden
    row('lib-disabled', { status: 'disabled', def: libDef(bearerMcp(GITHUB.url), 'github') }),                         // not running → hidden
    row('lib-other-org', { orgId: OTHER_ORG, def: libDef(bearerMcp(GITHUB.url), 'github') }),                          // other org → hidden
];

const ORIGINAL_DEPS = { ...deps };
let w;

function makeWorld() {
    const world = {
        rows: new Map(ROWS.map(r => [r.id, clone(r)])),
        users: { [ADMIN]: { id: ADMIN, organizationId: ORG }, [MEMBER]: { id: MEMBER, organizationId: ORG }, loner: { id: 'loner', organizationId: null } },
        // Entitled to everything except lib-not-entitled — including the other org's row.
        effective: ROWS.filter(r => r.id !== 'lib-not-entitled').map(r => `custom:${r.id}`),
        connections: new Map(),
        grants: [],
        acceptedKeys: new Set([ADMIN_KEY, MEMBER_KEY, 'ghp_rotated_by_admin_000']),
        resolverFails: false,
        log: [],
        seq: 0,
    };
    const rec = (what, ...args) => world.log.push([what, ...args]);
    const pub = (c) => { const { secret: _secret, ...rest } = c; return clone(rest); };

    world.addConnection = (ownerUserId, rowId, token, { isDefault = true } = {}) => {
        const id = `conn-${++world.seq}`;
        world.connections.set(id, {
            id, ownerUserId, orgId: ORG, provider: `custom:${rowId}`, kind: 'mcp', isDefault, status: 'active',
            secret: { token }, secretMeta: { boundOrigin: new URL(GITHUB.url).origin, fields: ['token'] },
        });
        return id;
    };
    world.lend = (connectionId) => {
        const g = { id: `grant-${++world.seq}`, connection_id: connectionId, grantee_type: 'org', grantee_id: null, org_id: ORG, revoked_at: null };
        world.grants.push(g);
        return g;
    };

    world.deps = {
        store: () => ({
            listActiveForOrg: async (orgId) => {
                rec('listActiveForOrg', orgId);
                return [...world.rows.values()].filter(r => r.orgId === orgId && r.status === 'active').map(clone);
            },
        }),
        connStore: () => ({
            listGrants: async ({ orgId }) => world.grants
                .filter(g => g.org_id === orgId && !g.revoked_at && world.connections.has(g.connection_id))
                .map(g => ({ ...clone(g), provider: world.connections.get(g.connection_id).provider })),
            getDefaultConnection: async (userId, provider) => {
                const c = [...world.connections.values()].find(x => x.ownerUserId === userId && x.provider === provider && x.isDefault);
                return c ? pub(c) : null;
            },
            listConnectionsForUser: async (userId, provider) => [...world.connections.values()]
                .filter(x => x.ownerUserId === userId && x.provider === provider).map(pub),
            createConnection: async (p) => {
                rec('createConnection', clone(p));
                const id = `conn-${++world.seq}`;
                world.connections.set(id, { id, ownerUserId: p.ownerUserId, orgId: p.orgId, provider: p.provider, kind: p.kind, isDefault: !!p.makeDefault, status: 'active', secret: clone(p.secretObject), secretMeta: clone(p.secretMeta) });
                return pub(world.connections.get(id));
            },
            updateConnectionSecret: async (id, secretObject, secretMeta) => {
                rec('updateConnectionSecret', id, clone(secretObject), clone(secretMeta));
                const c = world.connections.get(id);
                c.secret = clone(secretObject);
                if (secretMeta) c.secretMeta = clone(secretMeta);
                return true;
            },
            deleteConnection: async (id) => { rec('deleteConnection', id); return world.connections.delete(id); },
        }),
        userStore: () => ({ getUser: async (id) => clone(world.users[id]) || null }),
        entitlements: () => ({
            resolveEntitlements: async ({ userId, orgId }) => {
                rec('resolveEntitlements', { userId, orgId });
                if (world.resolverFails) throw new Error('resolver down');
                return { effective: { integration: [...world.effective] } };
            },
        }),
        mcpClient: () => ({
            discoverTools: async (probe, { secretObject } = {}) => {
                rec('discoverTools', clone(probe), clone(secretObject));
                const value = secretObject && secretObject.token;
                if (!value || !world.acceptedKeys.has(value)) throw new Error('Error POSTing to endpoint (HTTP 401): Bad credentials');
                return { tools: [{ name: 'search', description: '', inputSchema: { type: 'object', properties: {} } }], warnings: [] };
            },
            closeIntegration: async (id) => { rec('closeIntegration', id); },
        }),
        configStore: () => ({ getConfig: async () => ({ remote: 'official' }) }),
        // The builder is on: a builder row is still not something a member manages here.
        isBuilderEnabled: async () => true,
        mcpStore: () => { throw new Error('members never read the server-wide MCP store'); },
    };
    world.calls = (what) => world.log.filter(e => e[0] === what).map(e => e.slice(1));
    world.indexOf = (what) => world.log.findIndex(e => e[0] === what);
    return world;
}

const asUser = (id) => ({ session: { user: { id } } });

beforeEach(() => {
    w = makeWorld();
    Object.assign(deps, w.deps);
});
afterEach(() => { Object.assign(deps, ORIGINAL_DEPS); });

describe('listForMember', () => {
    it('shows only running, keyed library servers of the member\'s own org they are entitled to', async () => {
        const out = await members.listForMember(asUser(MEMBER));
        assert.deepStrictEqual(out.servers.map(s => s.id), ['lib-github']);
        assert.deepStrictEqual(w.calls('listActiveForOrg'), [[ORG]], 'only ever the member\'s own org');
    });

    it('describes the server and the key it takes, without any secret', async () => {
        const adminConn = w.addConnection(ADMIN, 'lib-github', ADMIN_KEY);
        w.lend(adminConn);
        const [server] = (await members.listForMember(asUser(MEMBER))).servers;
        assert.deepStrictEqual(server, {
            id: 'lib-github',
            name: 'GitHub',
            description: 'GitHub description',
            catalogId: 'github',
            host: 'api.githubcopilot.com',
            credential: { label: 'Personal access token', help: GITHUB.auth.credential.help, helpUrl: GITHUB.auth.credential.helpUrl },
            sharedKey: true,
            connected: false,
        });
        assert.ok(!JSON.stringify(server).includes(ADMIN_KEY));
    });

    it('connected reflects the member\'s own active key', async () => {
        w.addConnection(MEMBER, 'lib-github', MEMBER_KEY);
        const [server] = (await members.listForMember(asUser(MEMBER))).servers;
        assert.strictEqual(server.connected, true);
        assert.strictEqual(server.sharedKey, false);
    });

    it('a user without an organisation sees nothing and nothing is looked up', async () => {
        assert.deepStrictEqual(await members.listForMember(asUser('loner')), { servers: [] });
        assert.deepStrictEqual(w.calls('listActiveForOrg'), []);
        assert.deepStrictEqual(w.calls('resolveEntitlements'), []);
    });

    it('when the entitlement resolver is down, nothing is usable', async () => {
        w.resolverFails = true;
        assert.deepStrictEqual(await members.listForMember(asUser(MEMBER)), { servers: [] });
    });

    it('the policy switched off hides every library server', async () => {
        deps.configStore = () => ({ getConfig: async () => ({ remote: 'off' }) });
        assert.deepStrictEqual(await members.listForMember(asUser(MEMBER)), { servers: [] });
    });
});

describe('saveOwnCredential', () => {
    it('tries the key against the server first, then stores it as the member\'s own, bound to the origin', async () => {
        const out = await members.saveOwnCredential(asUser(MEMBER), 'lib-github', `  ${MEMBER_KEY}  `);
        assert.deepStrictEqual(out, { connected: true });

        const [[probe, secret]] = w.calls('discoverTools');
        assert.strictEqual(probe.definition.mcp.url, GITHUB.url);
        assert.deepStrictEqual(secret, { token: MEMBER_KEY });
        assert.deepStrictEqual(w.calls('createConnection'), [[{
            ownerUserId: MEMBER, orgId: ORG, provider: 'custom:lib-github', label: 'GitHub', kind: 'mcp',
            secretObject: { token: MEMBER_KEY },
            secretMeta: { boundOrigin: 'https://api.githubcopilot.com', fields: ['token'] },
            makeDefault: true, mirror: false,
        }]]);
        assert.ok(w.indexOf('discoverTools') < w.indexOf('createConnection'), 'probed before stored');
        assert.deepStrictEqual(w.calls('closeIntegration'), [['lib-github']]);
    });

    it('replaces the member\'s existing key in place', async () => {
        const mine = w.addConnection(MEMBER, 'lib-github', 'old-key');
        await members.saveOwnCredential(asUser(MEMBER), 'lib-github', MEMBER_KEY);
        assert.deepStrictEqual(w.calls('createConnection'), []);
        assert.deepStrictEqual(w.calls('updateConnectionSecret'), [[mine, { token: MEMBER_KEY }, { boundOrigin: 'https://api.githubcopilot.com', fields: ['token'] }]]);
    });

    it('a key the server refuses is not stored', async () => {
        await assert.rejects(members.saveOwnCredential(asUser(MEMBER), 'lib-github', 'wrong'), httpError(422, 'connect_auth_failed'));
        assert.deepStrictEqual(w.calls('createConnection'), []);
        assert.deepStrictEqual(w.calls('updateConnectionSecret'), []);
        assert.strictEqual(w.connections.size, 0);
    });

    for (const id of ['lib-keyless', 'lib-not-entitled', 'lib-blocked', 'builder-keyed', 'lib-disabled', 'lib-other-org', 'missing']) {
        it(`${id}: looks the same as a missing server (404) and is never probed`, async () => {
            await assert.rejects(members.saveOwnCredential(asUser(MEMBER), id, MEMBER_KEY), httpError(404, 'not_found'));
            assert.deepStrictEqual(w.calls('discoverTools'), []);
            assert.deepStrictEqual(w.calls('createConnection'), []);
        });
    }

    it('an empty key is refused; a non-text key is refused before anything is looked up', async () => {
        await assert.rejects(members.saveOwnCredential(asUser(MEMBER), 'lib-github', '   '), httpError(400, 'credential_required'));
        w.log.length = 0;
        await assert.rejects(members.saveOwnCredential(asUser(MEMBER), 'lib-github', 42), httpError(400, 'invalid_credential'));
        assert.deepStrictEqual(w.log, []);
        assert.deepStrictEqual(w.calls('discoverTools'), []);
    });

    it('the admin who lends the org key does not replace it through "my key"', async () => {
        const shared = w.addConnection(ADMIN, 'lib-github', ADMIN_KEY);
        w.lend(shared);
        await members.saveOwnCredential(asUser(ADMIN), 'lib-github', 'ghp_rotated_by_admin_000');
        assert.strictEqual(w.connections.get(shared).secret.token, ADMIN_KEY, 'the organisation\'s shared key must be unchanged');
        assert.strictEqual(w.calls('createConnection').length, 1, 'the admin gets a personal connection of their own');
    });
});

describe('deleteOwnCredential', () => {
    it('refuses (409) when the only connection is the organisation\'s shared key', async () => {
        const shared = w.addConnection(ADMIN, 'lib-github', ADMIN_KEY);
        w.lend(shared);
        await assert.rejects(members.deleteOwnCredential(asUser(ADMIN), 'lib-github'), httpError(409, 'shared_key'));
        assert.ok(w.connections.has(shared));
        assert.deepStrictEqual(w.calls('deleteConnection'), []);
        assert.deepStrictEqual(w.calls('closeIntegration'), []);
    });

    it('removes the member\'s own key and closes the pooled sessions', async () => {
        const shared = w.addConnection(ADMIN, 'lib-github', ADMIN_KEY);
        w.lend(shared);
        const mine = w.addConnection(MEMBER, 'lib-github', MEMBER_KEY);
        assert.deepStrictEqual(await members.deleteOwnCredential(asUser(MEMBER), 'lib-github'), { connected: false });
        assert.deepStrictEqual(w.calls('deleteConnection'), [[mine]]);
        assert.ok(w.connections.has(shared), 'the shared key stays');
        assert.deepStrictEqual(w.calls('closeIntegration'), [['lib-github']]);
    });

    it('for the lending admin, removes only their other keys, never the shared one', async () => {
        const shared = w.addConnection(ADMIN, 'lib-github', ADMIN_KEY);
        w.lend(shared);
        const second = w.addConnection(ADMIN, 'lib-github', 'another', { isDefault: false });
        await members.deleteOwnCredential(asUser(ADMIN), 'lib-github');
        assert.deepStrictEqual(w.calls('deleteConnection'), [[second]]);
        assert.ok(w.connections.has(shared));
    });

    it('without a shared grant the admin\'s key is just their own and goes', async () => {
        const own = w.addConnection(ADMIN, 'lib-github', ADMIN_KEY);
        await members.deleteOwnCredential(asUser(ADMIN), 'lib-github');
        assert.deepStrictEqual(w.calls('deleteConnection'), [[own]]);
    });

    it('with nothing stored it is a no-op that says not connected', async () => {
        assert.deepStrictEqual(await members.deleteOwnCredential(asUser(MEMBER), 'lib-github'), { connected: false });
        assert.deepStrictEqual(w.calls('deleteConnection'), []);
    });

    it('a server the member may not use is a 404 and nothing is deleted', async () => {
        w.addConnection(MEMBER, 'lib-not-entitled', MEMBER_KEY);
        await assert.rejects(members.deleteOwnCredential(asUser(MEMBER), 'lib-not-entitled'), httpError(404, 'not_found'));
        assert.deepStrictEqual(w.calls('deleteConnection'), []);
    });
});
