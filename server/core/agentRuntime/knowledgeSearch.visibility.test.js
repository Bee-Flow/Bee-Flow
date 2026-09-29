/**
 * The hole this closes, stated once:
 *
 *   A knowledge base shared with the Sales group, attached to an agent the
 *   whole organisation may talk to, answered questions for people outside
 *   Sales — with citations.
 *
 * The picker had always been honest about who may attach a base. The RUNTIME
 * never asked again, and the retrieval layer below it does no tenant
 * filtering of its own by design: its access boundary IS the id list it is
 * handed. So the id list is where this has to be right.
 *
 * Run: node --test --test-force-exit core/agentRuntime/knowledgeSearch.visibility.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

const KBS = {
    kb_org: { id: 'kb_org', tenant_id: 'owner', organization_id: 'org1', is_published: true, shared_groups: '[]' },
    kb_sales: { id: 'kb_sales', tenant_id: 'owner', organization_id: 'org1', is_published: true, shared_groups: '["g_sales"]' },
    kb_draft: { id: 'kb_draft', tenant_id: 'owner', organization_id: 'org1', is_published: false, shared_groups: '[]' },
    kb_other: { id: 'kb_other', tenant_id: 'owner', organization_id: 'org2', is_published: true, shared_groups: '[]' },
};

let USER = { id: 'u_asker', organizationId: 'org1', groups: [] };

const realStore = require('../../stores/knowledgeBases');

const MOCKS = {
    '../../stores/userStore': { getUser: async (id) => (id === USER.id ? USER : null) },
    '../../stores/knowledgeBases': {
        getKB: async (id) => KBS[id] || null,
        canUserAccessKB: realStore.canUserAccessKB,
    },
};
const IDS = {};
for (const [request, exports] of Object.entries(MOCKS)) {
    const id = `mock:kbvis:${request}`;
    IDS[request] = id;
    require.cache[id] = { id, filename: id, loaded: true, exports };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /(knowledgeSearch|kbVisibility|askerContext)\.js$/.test(parent.filename)) {
        // kbVisibility writes the store path one level shallower than
        // knowledgeSearch does; both point at the same stub.
        if (request === '../../stores/knowledgeBases') return IDS['../../stores/knowledgeBases'];
        if (request === '../../stores/userStore') return IDS['../../stores/userStore'];
    }
    return originalResolve.call(this, request, parent, ...rest);
};
test.after(() => { Module._resolveFilename = originalResolve; });

const { filterKbIdsForUser } = require('../kb/kbVisibility');
const { visibleKbIdsForTurn } = require('./knowledgeSearch');

/**
 * The filter as `performKnowledgeSearch` calls it. The surrounding function
 * needs a live model, a live retrieval service and a session; what is under
 * test is which ids reach them, so this exercises exactly that step with the
 * same resolvers the runtime uses.
 */
async function idsReachingRetrieval(rawKbIds, { userId = USER.id } = {}) {
    // The stub object directly: this file's OWN require is not intercepted
    // (the resolver hook matches the modules under test, not the test), and
    // reaching the real store here would open a database connection.
    const user = await MOCKS['../../stores/userStore'].getUser(userId);
    const orgIds = new Set([user?.organizationId].filter(Boolean));
    const groups = Array.isArray(user?.groups) ? user.groups : [];
    return filterKbIdsForUser(rawKbIds, {
        userId, orgIds, userGroups: groups, context: 'agent_chat',
        deps: { kbStore: MOCKS['../../stores/knowledgeBases'] },
    });
}

test('a base shared with a group does not answer for someone outside it', async () => {
    USER = { id: 'u_asker', organizationId: 'org1', groups: [] };
    const ids = await idsReachingRetrieval(['kb_org', 'kb_sales']);
    assert.deepStrictEqual(ids, ['kb_org'], 'the Sales base must not reach retrieval');
});

test('and does answer for someone inside it', async () => {
    USER = { id: 'u_asker', organizationId: 'org1', groups: ['g_sales'] };
    const ids = await idsReachingRetrieval(['kb_org', 'kb_sales']);
    assert.deepStrictEqual(ids, ['kb_org', 'kb_sales']);
});

test('a draft never answers for anyone but its owner', async () => {
    USER = { id: 'u_asker', organizationId: 'org1', groups: [] };
    assert.deepStrictEqual(await idsReachingRetrieval(['kb_draft']), []);

    USER = { id: 'owner', organizationId: 'org1', groups: [] };
    assert.deepStrictEqual(await idsReachingRetrieval(['kb_draft'], { userId: 'owner' }), ['kb_draft']);
});

test('a base in another organisation never answers', async () => {
    USER = { id: 'u_asker', organizationId: 'org1', groups: [] };
    assert.deepStrictEqual(await idsReachingRetrieval(['kb_other']), []);
});

test('an id nobody can resolve is dropped rather than passed down', async () => {
    // The retrieval layer does no filtering of its own — an unresolvable id
    // handed to it is an id it will happily search.
    USER = { id: 'u_asker', organizationId: 'org1', groups: [] };
    assert.deepStrictEqual(await idsReachingRetrieval(['kb_gone']), []);
});

test('a user the store cannot resolve gets nothing, not everything', async () => {
    // The failure direction matters more than the failure. A resolver that
    // returns null must narrow.
    USER = { id: 'u_asker', organizationId: 'org1', groups: [] };
    assert.deepStrictEqual(await idsReachingRetrieval(['kb_org'], { userId: 'u_unknown' }), []);
});

test('an agent with no bases asks for nothing', async () => {
    USER = { id: 'u_asker', organizationId: 'org1', groups: [] };
    assert.deepStrictEqual(await idsReachingRetrieval([]), []);
    assert.deepStrictEqual(await idsReachingRetrieval(undefined), []);
});

test('the asker is never told which base was withheld', async () => {
    // "You are not allowed to see that knowledge base" tells them a base
    // exists, roughly what it covers, and that a colleague has it — from a
    // question about something else entirely. The list simply gets shorter.
    USER = { id: 'u_asker', organizationId: 'org1', groups: [] };
    const ids = await idsReachingRetrieval(['kb_sales']);
    assert.deepStrictEqual(ids, []);
    assert.ok(!JSON.stringify(ids).includes('kb_sales'));
});

// ── The embed turn: nobody to evaluate ─────────────────────────────────────

test('an embedded agent answers the public from published org bases only', async () => {
    // `userId` is falsy on exactly one path — an unauthenticated visitor to an
    // embedded agent. Evaluating the turn as the OWNER would be the obvious
    // shortcut and the wrong one: it would let a draft answer the internet.
    USER = { id: 'owner', organizationId: 'org1', groups: ['g_sales'] };
    const agent = { id: 'ag1', owner_id: 'owner' };

    assert.deepStrictEqual(
        await visibleKbIdsForTurn(['kb_org', 'kb_sales', 'kb_draft', 'kb_other'], { agent, userId: null }),
        ['kb_org'],
        'the owner is in Sales and owns the draft; the visitor is neither',
    );
});

test('an agent with no owner grounds an anonymous turn on nothing', async () => {
    const out = await visibleKbIdsForTurn(['kb_org'], { agent: { id: 'ag1' }, userId: null });
    assert.deepStrictEqual(out, [], 'no owner is no organisation to publish from');
});

test('a signed-in person chatting with an EMBEDDABLE agent is still a person', async () => {
    // The branch keys off "is there an asker", not off agent.embed_enabled —
    // otherwise an org member using an embeddable agent in the normal UI would
    // silently lose their own drafts.
    USER = { id: 'owner', organizationId: 'org1', groups: [] };
    const agent = { id: 'ag1', owner_id: 'owner', embed_enabled: true };
    assert.deepStrictEqual(
        await visibleKbIdsForTurn(['kb_org', 'kb_draft'], { agent, userId: 'owner' }),
        ['kb_org', 'kb_draft'],
    );
});

test('nothing configured is nothing searched, on either branch', async () => {
    assert.deepStrictEqual(await visibleKbIdsForTurn([], { agent: { id: 'a', owner_id: 'owner' }, userId: null }), []);
    assert.deepStrictEqual(await visibleKbIdsForTurn([], { agent: { id: 'a' }, userId: 'u_asker' }), []);
});
