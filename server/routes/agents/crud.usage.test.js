/**
 * DELETE /agents/:id — what breaks, before it breaks (A1c).
 *
 * The guard runs END TO END here: the real `routes/agents/usage.js`
 * `gatherUsage`, the real redaction, the real `canModifyAgent`. Only the
 * store is faked, because the question this suite answers is what the route
 * DECIDES, and a stubbed decision would have proved nothing.
 *
 * Four ways a delete must be refused, and the last three are the ones a
 * reassuring implementation lets through:
 *
 *   1. something still uses the agent — the obvious half;
 *   2. the scan could not CHECK something. A consumer table this install has
 *      not got, or a query that threw, is not "nothing uses this", and this is
 *      the one moment where guessing wrong is unrecoverable;
 *   3. the conversation count could not be read at all;
 *   4. the conversations that cascade away belong to colleagues. On a
 *      published agent this delete destroys their history, and nothing else
 *      in the response would have said so.
 *
 * And one way it must NOT be refused: your own draft, that only you ever
 * chatted with, stays one click.
 *
 * Run: cd server && node --test --test-force-exit routes/agents/crud.usage.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

const noop = () => {};
const mw = () => (req, res, next) => next();

const realUsage = require('../../stores/agent/agentUsage');

const fx = {
    userId: 'owner',
    agents: {},
    usage: { rows: [], partial: [] },
    usageThrows: false,
    chat: null,
    chatThrows: false,
    chatCalls: [],
    deleted: [],
    hasManage: true,
};

const STORE = {
    getAgent: async (id) => (fx.agents[id] ? { ...fx.agents[id] } : null),
    updateAgent: async () => ({ ok: true, rev: 2 }),
    getAgentCategories: async () => [],
    setAgentTools: async () => {},
    forceDeleteAgent: async (id) => { fx.deleted.push(id); return true; },
    usageForAgent: async () => {
        if (fx.usageThrows) throw new Error('every scan is down');
        return fx.usage;
    },
    getAgentChatStats: async (ids, opts) => {
        fx.chatCalls.push({ ids, opts });
        if (fx.chatThrows) throw new Error('conversations unreachable');
        return new Map(ids.map(id => [id, fx.chat]));
    },
};

const SHARED = {
    '../../stores/agentStore': STORE,
    '../../utils/routeHelpers': { getEffectiveUserId: () => fx.userId, getUserAuth: () => ({}) },
};
const CRUD_ONLY = {
    '../../core/agentRuntime': {},
    '../../core/aiAgent': { getAIConfig: noop, getProviderForModel: noop },
    '../../core/llm/modelResolver': { normalizeTierModel: (m) => m },
    '../../stores/configStore': {},
    '../../auth': {
        requirePermission: mw,
        requireActiveOrgForMutations: mw,
        OrgRoles: { AGENT_EDITOR: 'agent_editor' }, SystemRoles: { SUPER_ADMIN: 'super_admin' },
        hasPermission: async () => fx.hasManage,
        resolveUserOrgIds: async () => new Set(['orgA']),
        canSeePublished: () => false,
        resolveUserGroups: async () => [],
        assertUserCanUseOrg: async () => {},
        validateSharedGroupsForOrg: async () => [],
    },
    '../../stores/memoryStore': {},
    '../../stores/userStore': { getUser: async () => ({ orgRole: 'org_admin' }) },
    '../../stores/usageStore': {},
    '../../core/entitlements/limits': { checkSubscriptionLimits: async () => ({}), checkResourceLimits: async () => ({}) },
    '../../core/http/sseHelpers': { setupSSE: noop, sendSSEError: noop, persistAndTitle: async () => {}, getOrCreateAgentConversation: async () => {} },
};

const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries({ ...SHARED, ...CRUD_ONLY })) {
    const mockId = `mock:crud-usage:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    const from = parent && parent.filename;
    // Both files: crud.js requires ./usage at call time, and usage.js reaches
    // for the same store — one fake, two readers, exactly as in production.
    if (from && /agents[\\/](crud|usage)\.js$/.test(from) && MOCK_IDS[request]) return MOCK_IDS[request];
    return originalResolve.call(this, request, parent, ...rest);
};

const router = require('./crud');
test.after(() => { Module._resolveFilename = originalResolve; });

function dispatch({ url, query = {}, session = { user: { id: fx.userId } } }) {
    return new Promise((resolve, reject) => {
        const request = {
            method: 'DELETE', url, originalUrl: url, path: url, body: {}, query, headers: {}, session,
            get() { return undefined; },
        };
        const res = {
            statusCode: 200,
            status(c) { this.statusCode = c; return this; },
            json(b) { this.body = b; resolve(this); return this; },
            send(b) { this.body = b; resolve(this); return this; },
            end() { resolve(this); return this; },
        };
        router(request, res, (err) => reject(err || new Error(`fell through router: DELETE ${url}`)));
    });
}

const AGENT = (over = {}) => ({
    id: 'a1', owner_id: 'owner', organization_id: 'orgA',
    is_published: false, shared_groups: [], config: {}, rev: 1, ...over,
});
const NO_CHAT = { conversationCount: 0, userCount: 0, othersConversationCount: 0, lastUsedAt: null };
const TASK_ROW = { kind: 'task', id: 't1', title: 'Nightly report', role: 'routine', ownerId: 'owner', lastAt: null };

test.beforeEach(() => {
    fx.userId = 'owner';
    fx.agents = { a1: AGENT() };
    fx.usage = { rows: [], partial: [] };
    fx.usageThrows = false;
    fx.chat = { ...NO_CHAT };
    fx.chatThrows = false;
    fx.chatCalls = [];
    fx.deleted = [];
    fx.hasManage = true;
});

// ── The one delete that must stay one click ─────────────────────────

test('an agent nothing uses, with only the asker\'s own history, is deleted', async () => {
    fx.chat = { conversationCount: 4, userCount: 1, othersConversationCount: 0, lastUsedAt: '2026-09-01T00:00:00.000Z' };
    const res = await dispatch({ url: '/a1' });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(fx.deleted, ['a1']);
});

// ── The four refusals ───────────────────────────────────────────────

test('a consumer refuses the delete, names it, and destroys nothing', async () => {
    fx.usage = { rows: [TASK_ROW], partial: [] };
    const res = await dispatch({ url: '/a1' });
    assert.strictEqual(res.statusCode, 409);
    assert.strictEqual(res.body.code, 'in_use');
    assert.deepStrictEqual(res.body.counts, { task: 1 });
    assert.strictEqual(res.body.usage[0].title, 'Nightly report');
    assert.deepStrictEqual(fx.deleted, [], 'nothing was deleted while asking');
});

test('a kind that could not be CHECKED refuses the delete, with zero rows to show', async () => {
    // The whole point. "App Studio is not installed here" and "no app uses
    // this agent" are different statements, and the delete dialog reads the
    // second one as safe.
    fx.usage = { rows: [], partial: ['app'] };
    const res = await dispatch({ url: '/a1' });
    assert.strictEqual(res.statusCode, 409);
    assert.deepStrictEqual(res.body.usage, []);
    assert.deepStrictEqual(res.body.unchecked, ['app']);
    assert.deepStrictEqual(fx.deleted, []);
});

test('a scan pass that throws wholesale refuses the delete on every kind', async () => {
    fx.usageThrows = true;
    const res = await dispatch({ url: '/a1' });
    assert.strictEqual(res.statusCode, 409);
    assert.deepStrictEqual(res.body.unchecked, [...realUsage.KINDS]);
    assert.deepStrictEqual(fx.deleted, []);
});

test('a conversation count that cannot be read refuses the delete', async () => {
    // `chat: null` is "I do not know whose history this is", and the answer to
    // that is not "delete it".
    fx.chatThrows = true;
    const res = await dispatch({ url: '/a1' });
    assert.strictEqual(res.statusCode, 409);
    assert.strictEqual(res.body.chat, null);
    assert.ok(res.body.unchecked.includes('chat'));
    assert.deepStrictEqual(fx.deleted, []);
});

test('a colleague\'s conversations refuse the delete even when nothing else uses the agent', async () => {
    // A published agent's history is not the deleter's to throw away, and
    // `usage` alone would never have mentioned it.
    fx.agents.a1 = AGENT({ is_published: true });
    fx.chat = { conversationCount: 312, userCount: 7, othersConversationCount: 300, lastUsedAt: '2026-09-05T10:00:00.000Z' };
    const res = await dispatch({ url: '/a1' });
    assert.strictEqual(res.statusCode, 409);
    assert.deepStrictEqual(res.body.usage, []);
    assert.strictEqual(res.body.chat.othersConversationCount, 300);
    assert.strictEqual(res.body.audience.scope, 'organization');
    assert.deepStrictEqual(fx.deleted, []);
});

test('the exclusion is the DELETER, not the owner', async () => {
    // An org-admin deleting a colleague's agent waives nothing: every
    // conversation on it is somebody else's as far as they are concerned.
    fx.userId = 'org-admin';
    await dispatch({ url: '/a1' });
    assert.strictEqual(fx.chatCalls[0].opts.excludeUserId, 'org-admin');
});

// ── The confirmed second delete ─────────────────────────────────────

test('?confirm=1 proceeds — after the person has seen what breaks', async () => {
    fx.usage = { rows: [TASK_ROW], partial: ['app'] };
    fx.chat = { conversationCount: 312, userCount: 7, othersConversationCount: 300, lastUsedAt: null };
    const res = await dispatch({ url: '/a1?confirm=1', query: { confirm: '1' } });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(fx.deleted, ['a1']);
});

test('confirm=true is the same word; anything else is not a confirmation', async () => {
    fx.usage = { rows: [TASK_ROW], partial: [] };
    assert.strictEqual((await dispatch({ url: '/a1', query: { confirm: 'true' } })).statusCode, 200);
    fx.deleted = [];
    assert.strictEqual((await dispatch({ url: '/a1', query: { confirm: 'yes' } })).statusCode, 409);
    assert.strictEqual((await dispatch({ url: '/a1', query: { confirm: '0' } })).statusCode, 409);
    assert.deepStrictEqual(fx.deleted, []);
});

test('a request with no query object at all is NOT a confirmation', async () => {
    // Express always supplies `req.query`; not every caller into this router
    // does. An absent one reading as "confirmed" would turn the guard off for
    // exactly the callers nobody looked at.
    fx.usage = { rows: [TASK_ROW], partial: [] };
    const res = await new Promise((resolve, reject) => {
        const request = {
            method: 'DELETE', url: '/a1', originalUrl: '/a1', path: '/a1', body: {},
            headers: {}, session: { user: { id: fx.userId } }, get() { return undefined; },
        };
        const out = {
            statusCode: 200,
            status(c) { this.statusCode = c; return this; },
            json(b) { this.body = b; resolve(this); return this; },
            send(b) { this.body = b; resolve(this); return this; },
            end() { resolve(this); return this; },
        };
        router(request, out, (err) => reject(err || new Error('fell through router')));
    });
    assert.strictEqual(res.statusCode, 409);
    assert.deepStrictEqual(fx.deleted, []);
});

// ── Permission comes first ──────────────────────────────────────────

test('someone who may not edit the agent is refused BEFORE any usage is gathered', async () => {
    // A 403 that first tells you which routines your colleague runs is a
    // disclosure the permission check was there to prevent.
    fx.userId = 'stranger';
    fx.hasManage = false;
    fx.usage = { rows: [TASK_ROW], partial: [] };
    const res = await dispatch({ url: '/a1' });
    assert.strictEqual(res.statusCode, 403);
    assert.strictEqual(res.body.code, 'agent_not_editable');
    assert.strictEqual(res.body.usage, undefined);
    assert.deepStrictEqual(fx.chatCalls, [], 'nothing was even asked');
});

test('an agent that is not there is still a 404, not a 409', async () => {
    const res = await dispatch({ url: '/nope' });
    assert.strictEqual(res.statusCode, 404);
});

// ── The refusal is redacted like the tab ────────────────────────────

test('a consumer the deleter does not own is counted but not named', async () => {
    fx.usage = {
        rows: [{ ...TASK_ROW, id: 't2', title: 'Payroll export', ownerId: 'someone-else' }],
        partial: [],
    };
    const res = await dispatch({ url: '/a1' });
    assert.strictEqual(res.statusCode, 409);
    assert.strictEqual(res.body.usage[0].title, null);
    assert.strictEqual(res.body.usage[0].id, null, 'an id the deleter cannot open is of no use to them');
    assert.strictEqual(res.body.usage[0].ownerId, null, 'and it names the colleague who built it');
    assert.strictEqual(res.body.usage[0].foreign, true);
    assert.strictEqual(res.body.usage[0].kind, 'task', 'the kind stays — it is what "what breaks" needs');
    assert.deepStrictEqual(res.body.counts, { task: 1 }, 'the count is honest either way');
});
