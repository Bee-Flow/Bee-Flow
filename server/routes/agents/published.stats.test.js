/**
 * GET /agents/all — the list, with "312 conversations · last used 2 minutes
 * ago" and (on request) the used-by counters (A1c).
 *
 * Three properties:
 *
 *   • ONE batch query for the whole page. The old `getAgentStats` is a round
 *     trip per agent that also reads every stored message into Node, and its
 *     "last updated" is when the agent was last EDITED — the wrong fact under
 *     the heading people read as "still in use".
 *   • The used-by counters are OPT-IN (`?usage=1`), and when they are not
 *     asked for the field is ABSENT rather than empty — nothing may render
 *     "used by 0" off a number nobody computed. This list is fetched on load
 *     by the sidebar's recents, by Cowork and by three settings screens that
 *     show none of it.
 *   • Neither may take the list down, and neither may claim a count it does
 *     not have: a failed stats read is `stats: null`, a failed usage pass is
 *     every kind in `partial`.
 *
 * Run: cd server && node --test --test-force-exit routes/agents/published.stats.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

const noop = () => {};
const mw = () => (req, res, next) => next();

const realUsage = require('../../stores/agent/agentUsage');

const fx = {
    userId: 'u1',
    all: [],
    statsCalls: [],
    usageCalls: [],
    statsThrows: false,
    usageThrows: false,
    stats: new Map(),
    usage: {},
};

const MOCKS = {
    '../../stores/agentStore': {
        getAllAgents: async () => fx.all.map(a => ({ ...a })),
        getPublishedAgents: async () => [],
        getPublishedAgentsForUser: async () => [],
        getAgent: async () => null,
        setAgentPublished: async () => true,
        getAgentChatStats: async (ids, opts) => {
            fx.statsCalls.push({ ids, opts });
            if (fx.statsThrows) throw new Error('conversations unreachable');
            return fx.stats;
        },
        usageCountsForAgents: async (ids) => {
            fx.usageCalls.push(ids);
            if (fx.usageThrows) throw new Error('every scan is down');
            return fx.usage;
        },
    },
    '../../core/agentRuntime': {},
    '../../core/aiAgent': { getAIConfig: noop, getProviderForModel: noop },
    '../../stores/configStore': {},
    '../../auth': {
        requirePermission: mw,
        resolveUserOrgIds: async () => null,
        validateSharedGroupsForOrg: async (org, groups) => groups,
    },
    '../../stores/memoryStore': {},
    '../../utils/routeHelpers': { getEffectiveUserId: () => fx.userId, getUserAuth: () => ({}) },
    '../../stores/userStore': { getUser: async () => ({ groups: [], organizationId: null }), getAllGroups: async () => [] },
    '../../stores/usageStore': {},
    '../../core/entitlements/limits': { checkSubscriptionLimits: async () => ({}), checkResourceLimits: async () => ({}) },
    '../../core/http/sseHelpers': { setupSSE: noop, sendSSEError: noop, persistAndTitle: async () => {}, getOrCreateAgentConversation: async () => {} },
    './crud': {
        canModifyAgent: async (a) => a.owner_id === fx.userId,
        buildCanModifyContext: async () => ({}),
        validateAgentConfigReferences: async () => ({ warnings: [] }),
    },
    '../../compliance/events': { EVENTS: { AGENT_PUBLISHED: 'agent_published' }, emit: noop },
};
const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:published-stats:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /agents[\\/]published\.js$/.test(parent.filename) && MOCK_IDS[request]) return MOCK_IDS[request];
    return originalResolve.call(this, request, parent, ...rest);
};

const router = require('./published');
test.after(() => { Module._resolveFilename = originalResolve; });

function dispatch({ url = '/all', query = {} } = {}) {
    return new Promise((resolve, reject) => {
        const request = {
            method: 'GET', url, originalUrl: url, path: url, body: {}, query, headers: {},
            session: { user: { id: fx.userId } }, get() { return undefined; },
        };
        const res = {
            statusCode: 200,
            status(c) { this.statusCode = c; return this; },
            json(b) { this.body = b; resolve(this); return this; },
            send(b) { this.body = b; resolve(this); return this; },
            end() { resolve(this); return this; },
        };
        router(request, res, (err) => reject(err || new Error(`fell through router: GET ${url}`)));
    });
}

const STAT = (over = {}) => ({
    conversationCount: 0, userCount: 0, othersConversationCount: 0, lastUsedAt: null, ...over,
});

test.beforeEach(() => {
    fx.userId = 'u1';
    fx.all = [
        { id: 'a1', owner_id: 'u1', name: 'Mine', organization_id: 'org1' },
        { id: 'a2', owner_id: 'u2', name: 'Theirs', organization_id: 'org1' },
    ];
    fx.statsCalls = [];
    fx.usageCalls = [];
    fx.statsThrows = false;
    fx.usageThrows = false;
    fx.stats = new Map([
        ['a1', STAT({ conversationCount: 312, userCount: 7, lastUsedAt: '2026-09-05T10:00:00.000Z' })],
        ['a2', STAT()],
    ]);
    fx.usage = { a1: { counts: { task: 2 }, partial: [] }, a2: { counts: {}, partial: [] } };
});

// ── stats ───────────────────────────────────────────────────────────

test('the whole page of stats comes from ONE call, and lands on the right rows', async () => {
    const res = await dispatch();
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(fx.statsCalls.length, 1);
    assert.deepStrictEqual(fx.statsCalls[0].ids, ['a1', 'a2']);
    const [a1, a2] = res.body;
    assert.deepStrictEqual(a1.stats, {
        conversationCount: 312, userCount: 7, othersConversationCount: 0,
        lastUsedAt: '2026-09-05T10:00:00.000Z',
    });
    assert.deepStrictEqual(a2.stats, {
        conversationCount: 0, userCount: 0, othersConversationCount: 0, lastUsedAt: null,
    });
});

test('othersConversationCount rijdt mee, en is de KIJKER-relatieve teller (A5)', async () => {
    // Het reed hier bewust niet mee toen het alleen een verwijder-vraag was.
    // De kaartvoet heeft het nodig als BEWIJS voor "Only you": `userCount` is
    // COUNT(DISTINCT user_id) over ALLE gesprekken, dus één telt net zo goed
    // als een collega die er veertig voerde terwijl de eigenaar er nul voerde.
    const res = await dispatch();
    assert.deepStrictEqual(Object.keys(res.body[0].stats).sort(),
        ['conversationCount', 'lastUsedAt', 'othersConversationCount', 'userCount']);
    assert.strictEqual(fx.statsCalls[0].opts.excludeUserId, 'u1',
        'de FILTER draait om wie er kijkt — geen andere gebruiker mag hem hergebruiken');
});

test('zonder gelezen kijker is "van iemand anders" ONBEKEND, geen nul', async () => {
    // Zonder excludeUserId telt de FILTER elke rij mee, en dan zou een 0 hier
    // "niemand anders" beweren zonder enig bewijs.
    fx.userId = null;
    fx.stats = new Map([['a1', STAT({ conversationCount: 9, userCount: 3, othersConversationCount: 9 })]]);
    const res = await dispatch();
    assert.strictEqual(fx.statsCalls[0].opts.excludeUserId, null);
    assert.strictEqual(res.body[0].stats.othersConversationCount, null);
    assert.strictEqual(res.body[0].stats.conversationCount, 9, 'de gemeten tellingen blijven staan');
});

test('a stats read that fails leaves the list standing and claims nothing', async () => {
    fx.statsThrows = true;
    const res = await dispatch();
    assert.strictEqual(res.statusCode, 200, 'this list is how admins reach every agent');
    assert.strictEqual(res.body[0].stats, null, 'null, never a zero somebody would read as a fact');
});

test('an agent the batch did not answer for reads as unknown, not as zero', async () => {
    fx.stats = new Map([['a1', STAT({ conversationCount: 5 })]]);
    const res = await dispatch();
    assert.strictEqual(res.body[0].stats.conversationCount, 5);
    assert.strictEqual(res.body[1].stats, null);
});

test('can_edit still comes from the same policy the mutating endpoints enforce', async () => {
    const res = await dispatch();
    assert.strictEqual(res.body[0].can_edit, true);
    assert.strictEqual(res.body[1].can_edit, false);
});

// ── the opt-in usage counters ───────────────────────────────────────

test('without ?usage=1 the counters are not computed and the field is ABSENT', async () => {
    const res = await dispatch();
    assert.strictEqual(fx.usageCalls.length, 0, 'a pass over every automation, app and page, skipped');
    assert.ok(!('usage' in res.body[0]), 'absent — an empty object would render "used by 0"');
});

test('?usage=1 attaches the counters', async () => {
    const res = await dispatch({ query: { usage: '1' } });
    assert.deepStrictEqual(fx.usageCalls, [['a1', 'a2']]);
    assert.deepStrictEqual(res.body[0].usage, { counts: { task: 2 }, partial: [] });
    assert.deepStrictEqual(res.body[1].usage, { counts: {}, partial: [] });
});

test('?usage=true is the same word', async () => {
    await dispatch({ query: { usage: 'true' } });
    assert.strictEqual(fx.usageCalls.length, 1);
});

test('a usage pass that fails reads as EVERY kind unknown, per agent', async () => {
    fx.usageThrows = true;
    const res = await dispatch({ query: { usage: '1' } });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.body[0].usage, { counts: {}, partial: [...realUsage.KINDS] });
    assert.deepStrictEqual(res.body[1].usage, { counts: {}, partial: [...realUsage.KINDS] });
});

test('an agent the usage pass skipped reads as unknown rather than as nothing', async () => {
    fx.usage = { a1: { counts: { task: 1 }, partial: [] } };
    const res = await dispatch({ query: { usage: '1' } });
    assert.deepStrictEqual(res.body[0].usage.counts, { task: 1 });
    assert.deepStrictEqual(res.body[1].usage.partial, [...realUsage.KINDS]);
});

// ── grounding: de regel achter "Antwoordt uit het hoofd" (A5) ───────

test('every row says where the agent is grounded, from the rule Studio Home uses', () => {
    fx.all = [
        { id: 'a1', owner_id: 'u1', name: 'Grounded', organization_id: 'org1', config: { knowledge_base_ids: ['kb1'] } },
        { id: 'a2', owner_id: 'u1', name: 'Bare', organization_id: 'org1', config: {} },
    ];
    return dispatch().then((res) => {
        assert.deepStrictEqual(res.body[0].grounding,
            { kb: true, tables: false, verdict: 'grounded' });
        assert.deepStrictEqual(res.body[1].grounding,
            { kb: false, tables: false, verdict: 'ungrounded' });
    });
});

test('a table grant grounds an agent — two axes, not KB only; websearch is not one', async () => {
    fx.all = [
        { id: 'a1', owner_id: 'u1', name: 'Tables', organization_id: 'org1', config: { tools: { datatables: { t1: {} } } } },
        // `config.enabledIntegrations` stuurt niets aan in het chatpad, en de
        // R4-backfill zette 'agent-search' in élke oudere rij. Zie de kop van
        // core/agentRuntime/agentGrounding.js.
        { id: 'a2', owner_id: 'u1', name: 'Web', organization_id: 'org1', config: { enabledIntegrations: ['agent-search'] } },
    ];
    const res = await dispatch();
    assert.strictEqual(res.body[0].grounding.verdict, 'grounded');
    assert.strictEqual(res.body[1].grounding.verdict, 'ungrounded');
});

test('a config nobody could read is verdict null — never "answers from memory"', async () => {
    // Onleesbaar is geen lege config. `null` is een DERDE waarde, en de
    // kaartvoet hoort daarop te zwijgen in plaats van te waarschuwen.
    fx.all = [
        { id: 'a1', owner_id: 'u1', name: 'Corrupt', organization_id: 'org1', config: 'not an object' },
        { id: 'a2', owner_id: 'u1', name: 'Half', organization_id: 'org1', config: { knowledge_base_ids: 'kb1' } },
    ];
    const res = await dispatch();
    assert.strictEqual(res.body[0].grounding.verdict, null);
    assert.strictEqual(res.body[1].grounding.verdict, null);
    assert.strictEqual(res.body[1].grounding.kb, null, 'de as die niet te lezen was, met naam');
});

// ── nothing to do ───────────────────────────────────────────────────

test('an empty list asks nothing', async () => {
    fx.all = [];
    const res = await dispatch({ query: { usage: '1' } });
    assert.deepStrictEqual(res.body, []);
    assert.strictEqual(fx.statsCalls.length, 0);
    assert.strictEqual(fx.usageCalls.length, 0);
});
