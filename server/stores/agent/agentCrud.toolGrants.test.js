/**
 * Per-action tool grants as the RUNTIME reads them (A1).
 *
 * `config.tools` is clamped on the way out, not only on the way in: a row can
 * reach the runtime without ever passing the route — written before the rule
 * existed, restored from a version snapshot, patched by the MCP builder, or
 * copied from another agent. The legacy agent editor makes that concrete: it
 * rebuilds `config` from a fixed field list on every save, so a key it does
 * not know about is dropped rather than preserved. Neither end may be the only
 * place the rule lives.
 *
 * The load-bearing assertion is the FIRST one: an agent without a grants map
 * must come back from getForRuntime exactly as it does today, and must not pay
 * for the feature either — the guard returns before the tool registry is even
 * loaded.
 *
 * Run: cd server && node --test --test-force-exit stores/agent/agentCrud.toolGrants.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

// ── In-memory "agents" table ────────────────────────────────────────
const table = new Map();
const clone = (r) => (r ? { ...r } : null);

function seed(id, config, extra = {}) {
    table.set(id, {
        id, owner_id: 'owner', name: 'seed', rev: 1, is_published: true,
        system_prompt: 'live prompt', config: JSON.stringify(config),
        shared_groups: '[]', organization_id: null,
        published_config: null, published_system_prompt: null,
        published_version: 0, published_rev: null, published_at: null,
        ...extra,
    });
}

const mockDb = {
    async exec() {},
    async getOne(sql, params) {
        if (/^SELECT \* FROM agents WHERE id = \$1/.test(sql)) return clone(table.get(params[0]));
        return null;
    },
    async getAll() { return []; },
    async run() { return { rowCount: 0, rows: [] }; },
};

// How many times the registry index was built — the cost guard below reads it.
let registryLoads = 0;

const MOCKS = {
    // agentCrud's own dependencies
    '../../db': mockDb,
    './initSchema': { initDB: async () => {} },
    './agentTools': {
        getAgentTools: async () => [],
        getAgentToolsWithParams: async () => [],
        getAgentToolsBatch: async () => new Map(),
        getAgentToolsWithParamsBatch: async () => new Map(),
    },
    // toolPolicy's dependencies — stubbed so the assertions describe a SHAPE
    // rather than whichever integrations happen to ship this week. The effect
    // classes still come from the real sideEffectMap.
    '../../../automation/toolRegistry': {
        get TOOL_REGISTRY() { registryLoads++; return [{ app: 'gmail', label: 'Gmail' }]; },
        INLINE_TOOL_APPS: [],
        // De teller hangt aan de getter die de attributie-index ECHT leest.
        // Sinds A2-1 is dat `ALL_TOOL_APPS` (registry + de apps die hun tools
        // inline injecteren); aan TOOL_REGISTRY blijven hangen zou de assertie
        // "de registry werd niet aangeraakt" onvervulbaar en dus leeg maken.
        get ALL_TOOL_APPS() { registryLoads++; return [{ app: 'gmail', label: 'Gmail' }]; },
        loadTools: () => [
            { function: { name: 'gmail_search' } },
            { function: { name: 'gmail_compose' } },
        ],
    },
    '../../integrations/connectionResolution': {
        isLendingEnabled: () => false,          // the product default
        providerForTool: () => 'google',
    },
};
const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:toolGrants:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    const from = parent && parent.filename;
    const mine = from && /(agent[\\/]agentCrud\.js|agentRuntime[\\/]toolPolicy[\\/][^\\/]+\.js)$/.test(from);
    if (mine && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) return MOCK_IDS[request];
    return originalResolve.call(this, request, parent, ...rest);
};

// A seam for "the policy module is unreachable". The real module is loaded
// through the same stubbed registry and proxied, so the failure is switched on
// for one test rather than faked with a hand-written double.
let POLICY_BROKEN = false;
const realPolicy = require('../../core/agentRuntime/toolPolicy');
const brokenId = 'mock:toolGrants:policy';
require.cache[brokenId] = {
    id: brokenId, filename: brokenId, loaded: true,
    exports: new Proxy({}, {
        get(_t, k) {
            if (POLICY_BROKEN) throw new Error('policy module unavailable');
            return realPolicy[k];
        },
    }),
};
MOCK_IDS['../../core/agentRuntime/toolPolicy'] = brokenId;

const store = require('./agentCrud');
test.after(() => { Module._resolveFilename = originalResolve; });

// ── The invisibility pin ────────────────────────────────────────────

test('an agent with no grants map is served byte-identically, and pays nothing for the feature', async () => {
    const config = {
        knowledge_base_ids: ['kb-1'],
        attachedSkillIds: ['s-1'],
        enabledIntegrations: ['gmail', 'google-drive'],
        disableExternalTools: false,
    };
    seed('a-legacy', config);
    const before = registryLoads;

    const agent = await store.getForRuntime('a-legacy');

    assert.deepStrictEqual(agent.config, config,
        'not one key added, removed or reordered — this is what "invisible until someone sets the ' +
        'new fields" means, and every agent in the product is in this state today');
    assert.ok(!('tools' in agent.config), 'an agent must not ACQUIRE a grants map just by being read');
    assert.strictEqual(registryLoads, before,
        'the clamp must return before the tool registry is touched: this runs on every chat turn');
    assert.strictEqual(agent.runtimeSource, 'live');
});

test('the published blobs still never leave the store', async () => {
    seed('a-pub', { tools: { gmail: { actions: '*' } } }, {
        published_config: { tools: { gmail: { actions: ['gmail_search'] } } },
        published_system_prompt: 'published prompt',
        published_version: 3, published_rev: 1,
    });

    const agent = await store.getForRuntime('a-pub');

    assert.strictEqual(agent.runtimeSource, 'published');
    assert.deepStrictEqual(agent.config.tools.gmail.actions, ['gmail_search'],
        'the runtime reads the PUBLISHED grants, not the concept');
    assert.ok(!('published_config' in agent));
    assert.ok(!('published_system_prompt' in agent));
});

// ── The clamp ───────────────────────────────────────────────────────

test('a stored "direct" on an action that sends reads back as "ask"', async () => {
    seed('a-send', { tools: { gmail: { actions: ['gmail_compose'], confirm: 'direct' } } });

    const agent = await store.getForRuntime('a-send');

    assert.strictEqual(agent.config.tools.gmail.confirm, 'ask',
        'a row that skipped the route — a restore, an MCP patch, a copy — must still be clamped');
});

test('actAs "owner" reads back as "viewer" while lending is off', async () => {
    seed('a-lend', { tools: { 'google-drive': { actions: '*', actAs: 'owner' } } });

    const agent = await store.getForRuntime('a-lend');

    assert.strictEqual(agent.config.tools['google-drive'].actAs, 'viewer',
        '"I could not check whether a connection was lent" is not "yes"');
});

test('a junk grants map neither throws nor widens', async () => {
    seed('a-junk', {
        enabledIntegrations: ['gmail'],
        tools: { gmail: 'not-an-object', 'google-drive': { actions: 'drive_search' } },
    });

    const agent = await store.getForRuntime('a-junk');

    // KEPT, granting nothing. This line used to assert the opposite — that an
    // unreadable entry is DROPPED — and dropping is the widening: a missing
    // entry means "every action of this app" to every reader in toolPolicy.js,
    // so the clamp handed `a-junk` the whole of Gmail on the strength of a
    // value nobody could read.
    assert.ok('gmail' in agent.config.tools, 'an unreadable entry survives — dropping it granted the whole app');
    assert.deepStrictEqual(agent.config.tools.gmail.actions, [], 'granting nothing');
    assert.ok(!realPolicy.isToolAllowed('gmail_compose', agent.config.tools),
        'and the clamped map may not offer what the raw one refused to describe');
    assert.deepStrictEqual(agent.config.tools['google-drive'].actions, [],
        'and an unreadable ACTIONS value grants nothing — it used to come back as the whole app');
    assert.deepStrictEqual(agent.config.enabledIntegrations, ['gmail'],
        'the rest of the config is untouched');
});

test('a stored datatable grant reaches the runtime CLAMPED, never as it was written', async () => {
    // The runtime read is the half that matters: a row written before this rule
    // existed — or by a client that skipped the route — must not reach
    // `datatable_query` with a scope nobody clamped. `{scope:'everything'}` is
    // an access answer nobody can read, and reading it as "every row" is the
    // one direction the owner cannot undo.
    seed('a-tables', {
        enabledIntegrations: ['gmail'],
        tools: { datatables: { t1: { scope: 'everything' }, t2: { scope: 'all', columns: ['naam'] } } },
    });

    const agent = await store.getForRuntime('a-tables');

    assert.strictEqual(agent.config.tools.datatables.t1.scope, 'own');
    assert.deepStrictEqual(agent.config.tools.datatables.t2, { scope: 'all', columns: ['naam'] });
    assert.strictEqual(realPolicy.hasCuratedGrants(agent.config.tools), true,
        'and it IS the opt-in now: something enforces it, so picking a table is a curation');
});

test('an empty action list survives the round trip — "I picked none" is a choice', async () => {
    seed('a-none', { tools: { gmail: { actions: [] } } });

    const agent = await store.getForRuntime('a-none');

    assert.deepStrictEqual(agent.config.tools.gmail.actions, [],
        'collapsing this to "*" would silently re-grant the whole app');
});

test('an EMPTY map does not opt the agent into the new regime', async () => {
    // `tools: {}` is what a bad PUT, an MCP patch or a restore leaves behind
    // once every refused SECTION has been taken out of it. That is the same
    // nothing as no map at all, and the policy has to agree — a map-shaped
    // nothing that counted as "someone has been through the picker" would make
    // this agent ask before every send, and would drop the send tool entirely
    // from an unattended run: a mailing automation that silently stops mailing.
    seed('a-empty', { enabledIntegrations: ['gmail'], tools: {} });

    const agent = await store.getForRuntime('a-empty');
    assert.deepStrictEqual(agent.config.tools, {}, 'a map of nothing stays a map of nothing');

    const stack = [{ function: { name: 'gmail_compose' } }, { function: { name: 'gmail_search' } }];
    const policy = realPolicy.buildToolPolicy({ agentConfig: agent.config, tools: stack });
    assert.strictEqual(policy.gatedTools.size, 0, 'nobody curated anything, so nothing is held back');

    const headless = realPolicy.buildToolPolicy({ agentConfig: agent.config, tools: stack, unattended: true });
    assert.ok(headless.allowedToolNames.has('gmail_compose'));
    assert.deepStrictEqual(headless.droppedForUnattended, []);
});

// The junk-only map used to be asserted alongside `{}` above, as the same
// nothing. It is not, and pretending it was is what made the clamp widen: the
// only way to reach `{}` from `{gmail: 'nope'}` is to DELETE the entry, and a
// deleted entry reads as "every action of this app". So the entry stays, as a
// refusal — and a refusal is content, which the opt-in boundary can see.
//
// The trade, stated where someone changing it will read it: this agent now
// enters the confirmation regime. Its own Gmail tools were already refused by
// the narrowing (that half is not a choice — the entry is unreadable), and
// what the regime adds is that a `sends` tool of ANOTHER app is held back, and
// dropped from an unattended run. That is the closed side: it never grants,
// it only asks. The open side — handing back a whole app nobody granted — is
// the one this layer may not take.
test('a junk-only map narrows, and the narrowing is what arms the regime', async () => {
    seed('a-junk-only', { enabledIntegrations: ['gmail'], tools: { gmail: 'nope' } });

    const agent = await store.getForRuntime('a-junk-only');
    assert.deepStrictEqual(agent.config.tools, { gmail: { actions: [], actAs: 'viewer' } },
        'the refusal is stored, not deleted');

    const stack = [{ function: { name: 'gmail_compose' } }, { function: { name: 'gmail_search' } }];
    assert.ok(!realPolicy.isToolAllowed('gmail_compose', agent.config.tools),
        'the app the owner made unreadable grants nothing at all');

    const headless = realPolicy.buildToolPolicy({ agentConfig: agent.config, tools: stack, unattended: true });
    assert.ok(!headless.allowedToolNames.has('gmail_compose'),
        'not offered — which is the refusal, not the regime');
});

// ── Draft vs runtime ────────────────────────────────────────────────

test('getAgentViews clamps the runtime view and leaves the editor its own copy', async () => {
    seed('a-views', { tools: { gmail: { actions: ['gmail_compose'], confirm: 'direct' } } });

    const { draft, runtime } = await store.getAgentViews('a-views');

    assert.strictEqual(draft.config.tools.gmail.confirm, 'direct',
        'the picker has to be able to show what is stored, including a value the runtime will clamp');
    assert.strictEqual(runtime.config.tools.gmail.confirm, 'ask',
        '"what will actually run" is never a second opinion');
});

// ── When the clamp itself is unavailable ────────────────────────────

test('an unreachable policy module keeps the stored grants — dropping them would GRANT more', async () => {
    seed('a-broken', { tools: { gmail: { actions: ['gmail_search'] } } });
    POLICY_BROKEN = true;
    try {
        const agent = await store.getForRuntime('a-broken');

        assert.deepStrictEqual(agent.config.tools.gmail.actions, ['gmail_search'],
            'a missing map means "every action of every enabled app", so deleting the map on a ' +
            'module failure would hand the agent back exactly the actions its owner unticked');
    } finally {
        POLICY_BROKEN = false;
    }
});
