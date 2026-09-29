/**
 * What the agent category, transfer and tool-param routes accept, and what
 * they say when they refuse (routes/agents/crud.js).
 *
 * The checks these schemas replaced answered "Name is required" to a category
 * named `42` — the name was there, it just was not text — and `newOwnerId is
 * required` to a transfer that named an owner as a number. What this file
 * pins is the part a caller can act on:
 *
 *   - the 400 NAMES the field (`body.name`), not just "invalid request";
 *   - the message is a sentence, including for a field simply left out;
 *   - the store is never reached, so a refused request changes nothing.
 *
 * PUT /:id has one too, since 23 September, and the second half of this file
 * is about it. The save read every on/off setting it was NOT sent as
 * `agent.x_enabled !== 0` — a test against the integer the SQLite era stored.
 * On Postgres those columns are booleans and `false !== 0` is true, so a save
 * that did not mention them switched every one that was off back ON: the
 * agent's own editor never sends three of the four, and embed ON also turns
 * the agent's memory off (core/memory/memoryPolicy.js). What is pinned here:
 *
 *   - a setting the request does not mention stays exactly as stored, and so
 *     does the description (it used to be written as '');
 *   - a setting that IS sent is true or false (or the 1/0 two editors send),
 *     never the string 'false' that `!!` would have read as true;
 *   - a misspelled key is refused by name instead of saving nothing;
 *   - every body a real client sends still saves — the list is at the bottom.
 *
 * POST / still has no schema; the note above it in crud.js says why.
 *
 * Run: cd server && node --test routes/agents/crud.validation.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

// ── Fixtures ────────────────────────────────────────────────────────
// Every store call lands in `touched`. A refused request must leave it empty.
const touched = [];

const CATEGORY = { id: 'sales', organization_id: 'orgA', name: 'Sales' };
const AGENT = { id: 'a1', owner_id: 'user1', organization_id: 'orgA' };

/**
 * The agent row as Postgres hands it back: BOOLEAN columns arrive as true or
 * false, never 0 or 1. Every setting is OFF here on purpose — the column
 * defaults switch threads and copy on, so an off value is what a save that
 * "falls back to what is stored" has to get right. Tests replace fields.
 */
const STORED_ROW = Object.freeze({
    ...AGENT,
    name: 'Contract reader',
    description: 'Reads supplier contracts',
    system_prompt: 'Read the contract.',
    model: 'tier:fast',
    avatar: '📄',
    starter_prompts: [],
    shared_groups: [],
    category_id: null,
    config: {},
    threads_enabled: false,
    copy_enabled: false,
    workspace_enabled: false,
    embed_enabled: false,
});
let stored = { ...STORED_ROW };

const noop = () => {};
const mw = () => (req, res, next) => next();

const MOCKS = {
    '../../stores/agentStore': {
        getAgentCategory: async (id) => { touched.push({ what: 'getAgentCategory', args: [id] }); return id === 'sales' ? { ...CATEGORY } : null; },
        findAgentCategoryByName: async (...a) => { touched.push({ what: 'findAgentCategoryByName', args: a }); return null; },
        createAgentCategory: async (...a) => { touched.push({ what: 'createAgentCategory', args: a }); return { id: 'new', name: a[1] }; },
        updateAgentCategory: async (...a) => { touched.push({ what: 'updateAgentCategory', args: a }); return { ...CATEGORY }; },
        countAgentsInCategory: async () => 0,
        reassignAgentsCategory: async (...a) => { touched.push({ what: 'reassignAgentsCategory', args: a }); return 0; },
        deleteAgentCategory: async (...a) => { touched.push({ what: 'deleteAgentCategory', args: a }); return true; },
        getAgent: async (id) => { touched.push({ what: 'getAgent', args: [id] }); return { ...stored }; },
        getAgentCategories: async () => [],
        updateAgent: async (...a) => { touched.push({ what: 'updateAgent', args: a }); return { ok: true, rev: 2 }; },
        setAgentTools: async (...a) => { touched.push({ what: 'setAgentTools', args: a }); },
        updateAgentToolParams: async (...a) => { touched.push({ what: 'updateAgentToolParams', args: a }); return true; },
        transferAgentOwner: async (...a) => { touched.push({ what: 'transferAgentOwner', args: a }); return true; },
    },
    '../../core/agentRuntime': {},
    '../../core/aiAgent': { getAIConfig: noop, getProviderForModel: noop },
    '../../core/llm/modelResolver': { normalizeTierModel: (m) => m },
    '../../stores/configStore': {},
    '../../auth': {
        requirePermission: mw,
        requireActiveOrgForMutations: mw,
        OrgRoles: { AGENT_EDITOR: 'agent_editor' }, SystemRoles: { SUPER_ADMIN: 'admin' },
        hasPermission: async () => true,
        resolveUserOrgIds: async () => new Set(['orgA']),
        canSeePublished: () => false,
        resolveUserGroups: async () => [],
        assertUserCanUseOrg: async () => {},
        validateSharedGroupsForOrg: async () => [],
        isOrgAdminRole: () => true,
    },
    '../../stores/memoryStore': {},
    '../../utils/routeHelpers': { getEffectiveUserId: () => 'user1', getUserAuth: () => ({}) },
    '../../stores/userStore': {
        getUser: async (id) => ({ id, organizationId: 'orgA', orgRole: 'org_admin' }),
        logAccessAudit: async () => {},
    },
    '../../stores/usageStore': {},
    '../../core/entitlements/limits': { checkSubscriptionLimits: async () => ({}), checkResourceLimits: async () => ({}) },
    '../../core/http/sseHelpers': { setupSSE: noop, sendSSEError: noop, persistAndTitle: async () => {}, getOrCreateAgentConversation: async () => {} },
};

const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:agents-crud-validation:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /agents[\\/]crud\.js$/.test(parent.filename)
        && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const router = require('./crud');
test.after(() => { Module._resolveFilename = originalResolve; });

// A schema refusal travels as an error to the terminal handler, so the
// harness has to answer one the way index.js does.
const { terminalErrorHandler } = require('../../core/http/terminalErrorHandler');

function dispatch({ method, url, body = {} }) {
    return new Promise((resolve, reject) => {
        const [pathname, search = ''] = String(url).split('?');
        const req = {
            method, url, originalUrl: url, path: pathname, body,
            query: Object.fromEntries(new URLSearchParams(search)),
            headers: {}, session: { user: { id: 'user1' } },
            get() { return undefined; },
        };
        const res = {
            statusCode: 200,
            headersSent: false,
            status(c) { this.statusCode = c; return this; },
            json(b) { this.body = b; this.headersSent = true; resolve(this); return this; },
            send(b) { this.body = b; this.headersSent = true; resolve(this); return this; },
            end() { this.headersSent = true; resolve(this); return this; },
        };
        router(req, res, (err) => {
            if (!err) return reject(new Error(`fell through: ${method} ${url}`));
            terminalErrorHandler(err, req, res, (e) => reject(e));
        });
    });
}

test.beforeEach(() => { touched.length = 0; stored = { ...STORED_ROW }; });

/** Assert: refused with 400, the named field is in `details`, nothing touched. */
async function refuses(request, field) {
    const res = await dispatch(request);
    const what = `${request.method} ${request.url} ${JSON.stringify(request.body)}`;
    assert.strictEqual(res.statusCode, 400, what);
    assert.strictEqual(res.body.code, 'invalid_request', what);
    assert.ok(res.body.details.some((d) => d.path === field),
        `the 400 must name ${field}; it said ${JSON.stringify(res.body.details)}`);
    assert.deepStrictEqual(touched, [], 'a refused request must not reach the store');
}

// ═══ POST /categories ═══════════════════════════════════════════════

test('a category with no name is refused in words, not with "Required"', async () => {
    const res = await dispatch({ method: 'POST', url: '/categories', body: {} });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'A category needs a name.', 'the caller reads this sentence');
    assert.ok(res.body.details.some((d) => d.path === 'body.name'));
    assert.deepStrictEqual(touched, []);
});

test('a blank name is refused with the same sentence as a missing one', async () => {
    const res = await dispatch({ method: 'POST', url: '/categories', body: { name: '   ' } });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'A category needs a name.');
});

test('a numeric name is refused by name, instead of "Name is required" for a name that was there', async () => {
    await refuses({ method: 'POST', url: '/categories', body: { name: 42 } }, 'body.name');
});

test('a key the route does not read is refused rather than answered with 200', async () => {
    await refuses({ method: 'POST', url: '/categories', body: { name: 'Sales', organizationId: 'orgB' } }, 'body');
});

test('a name is trimmed once, by the schema, on its way to the store', async () => {
    const res = await dispatch({ method: 'POST', url: '/categories', body: { name: '  Sales  ' } });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(touched.find((t) => t.what === 'createAgentCategory').args.slice(0, 2), ['orgA', 'Sales']);
});

// ═══ PATCH /categories/:id ══════════════════════════════════════════

test('a blank rename is refused rather than stored as an empty name', async () => {
    await refuses({ method: 'PATCH', url: '/categories/sales', body: { name: ' ' } }, 'body.name');
});

test('renaming a category does not have to resend its icon and colour', async () => {
    const res = await dispatch({ method: 'PATCH', url: '/categories/sales', body: { name: 'Verkoop' } });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(touched.find((t) => t.what === 'updateAgentCategory').args[1],
        { name: 'Verkoop', icon: undefined, color: undefined });
});

// ═══ DELETE /categories/:id ═════════════════════════════════════════

test('a query key the route does not read is refused rather than silently ignored', async () => {
    // `?reassign=marketing` — one letter short — used to delete the category
    // and uncategorise nothing, and answer 409 or 200 without a word about it.
    await refuses({ method: 'DELETE', url: '/categories/sales?reassign=marketing' }, 'query');
});

test('a blank reassignTo is refused rather than read as "no target given"', async () => {
    await refuses({ method: 'DELETE', url: '/categories/sales?reassignTo=' }, 'query.reassignTo');
});

// ═══ PUT /:id/transfer ══════════════════════════════════════════════

test('a transfer with no new owner is refused in words', async () => {
    const res = await dispatch({ method: 'PUT', url: '/a1/transfer', body: {} });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'A transfer needs the id of the new owner.');
    assert.ok(res.body.details.some((d) => d.path === 'body.newOwnerId'));
    assert.deepStrictEqual(touched, [], 'and the agent is not even read');
});

test('a numeric new owner is refused by name, not turned into "newOwnerId is required"', async () => {
    await refuses({ method: 'PUT', url: '/a1/transfer', body: { newOwnerId: 7 } }, 'body.newOwnerId');
});

// ═══ PUT /:id/tools/:componentId/params ═════════════════════════════

test('tool params must be an object, and the envelope is refused by name when it is not', async () => {
    await refuses({ method: 'PUT', url: '/a1/tools/c1/params', body: { params: 'api-key' } }, 'body.params');
});

test('a key beside params is refused rather than dropped in silence', async () => {
    await refuses({ method: 'PUT', url: '/a1/tools/c1/params', body: { params: {}, componentId: 'c2' } }, 'body');
});

test("a component's own params pass through whatever it declares", async () => {
    const res = await dispatch({ method: 'PUT', url: '/a1/tools/c1/params', body: { params: { endpoint: 'https://x.test', retries: 3 } } });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(touched.find((t) => t.what === 'updateAgentToolParams').args[2],
        { endpoint: 'https://x.test', retries: 3 });
});

// ═══ PUT /:id ═══════════════════════════════════════════════════════

/** A body as it arrives over the wire: JSON drops every `undefined`. */
const wire = (body) => JSON.parse(JSON.stringify(body));

const put = (body) => dispatch({ method: 'PUT', url: '/a1', body: wire(body) });

/** What PUT /:id handed agentStore.updateAgent, by name rather than by position. */
function saved() {
    const call = touched.find((t) => t.what === 'updateAgent');
    assert.ok(call, 'the save must reach agentStore.updateAgent');
    const [, name, description, systemPrompt, , model, starterPrompts, avatar,
        threadsEnabled, copyEnabled, workspaceEnabled, config, embedEnabled,
        organizationId, sharedGroups, categoryId, opts] = call.args;
    return {
        name, description, systemPrompt, model, starterPrompts, avatar,
        threadsEnabled, copyEnabled, workspaceEnabled, config, embedEnabled,
        organizationId, sharedGroups, categoryId, opts,
    };
}

const flagsOf = (s) => ({
    threadsEnabled: s.threadsEnabled, copyEnabled: s.copyEnabled,
    workspaceEnabled: s.workspaceEnabled, embedEnabled: s.embedEnabled,
});
const ALL_OFF = { threadsEnabled: false, copyEnabled: false, workspaceEnabled: false, embedEnabled: false };

test('a save that does not mention the on/off settings leaves every one of them off', async () => {
    // `{name}` is the whole body of a rename; the agent's own editor never
    // sends threads, copy or workspace at all. Each used to come back ON,
    // and embed ON is a public chat page plus the agent's memory switched off.
    const res = await put({ name: 'Contract reader v2' });
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    assert.deepStrictEqual(flagsOf(saved()), ALL_OFF);
});

test('a setting that is on stays on when the save does not mention it', async () => {
    stored = { ...STORED_ROW, threads_enabled: true, copy_enabled: true, workspace_enabled: true, embed_enabled: true };
    await put({ name: 'Contract reader v2' });
    assert.deepStrictEqual(flagsOf(saved()), {
        threadsEnabled: true, copyEnabled: true, workspaceEnabled: true, embedEnabled: true,
    });
});

test('a setting the row holds no value for falls back to its column default, not to "on"', async () => {
    stored = { ...STORED_ROW, threads_enabled: null, copy_enabled: null, workspace_enabled: null, embed_enabled: null };
    await put({ name: 'Contract reader v2' });
    // initSchema: threads and copy DEFAULT TRUE, workspace and embed DEFAULT FALSE.
    assert.deepStrictEqual(flagsOf(saved()), {
        threadsEnabled: true, copyEnabled: true, workspaceEnabled: false, embedEnabled: false,
    });
});

test('a save that does not mention the description keeps it instead of writing it empty', async () => {
    // The store writes `description || ''` unconditionally, so `undefined`
    // from a rename erased it; every other column here already fell back to
    // the stored row.
    await put({ name: 'Contract reader v2' });
    assert.strictEqual(saved().description, 'Reads supplier contracts');
});

test('a description sent empty is still a person clearing it', async () => {
    await put({ name: 'Contract reader v2', description: '' });
    assert.strictEqual(saved().description, '');
});

test('the 1 and 0 two editors send for a setting arrive in the store as true and false', async () => {
    // AgentDesignerPanel and the AgentDesigner hook both send
    // `workspaceEnabled: on ? 1 : 0`.
    await put({ name: 'x', workspaceEnabled: 1, copyEnabled: 0 });
    assert.strictEqual(saved().workspaceEnabled, true);
    assert.strictEqual(saved().copyEnabled, false);
});

test("the string 'false' is refused by name instead of being read as on", async () => {
    // `!!'false'` is true: this switched a public chat page ON.
    await refuses({ method: 'PUT', url: '/a1', body: { embedEnabled: 'false' } }, 'body.embedEnabled');
});

test("a refused setting is answered with a sentence, not with zod's wording", async () => {
    const res = await dispatch({ method: 'PUT', url: '/a1', body: { copyEnabled: 'no' } });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'copyEnabled is true or false.');
});

test('a misspelled setting is refused by name instead of saving nothing under a 200', async () => {
    const res = await dispatch({ method: 'PUT', url: '/a1', body: { embedEnable: true } });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, "An agent has no setting called 'embedEnable'.");
    assert.ok(res.body.details.some((d) => d.path === 'body'));
    assert.deepStrictEqual(touched, []);
});

test('config: null is refused rather than written as an empty config', async () => {
    // It skipped the reference checks and reached the store as `{}`: every
    // knowledge base, skill and tool grant gone under a 200.
    await refuses({ method: 'PUT', url: '/a1', body: { config: null } }, 'body.config');
});

test('a config key that could pollute the prototype is still refused by the route', async () => {
    // The schema must hand `config` through untouched: a rebuilt object would
    // drop `__proto__` in silence, and rejectUnsafeConfigKeys says it out loud.
    const res = await dispatch({ method: 'PUT', url: '/a1', body: JSON.parse('{"config":{"__proto__":{"polluted":true}}}') });
    assert.strictEqual(res.statusCode, 400);
    assert.match(res.body.error, /forbidden config key: __proto__/);
});

test('a baseVersion that is not a whole number is refused instead of saving unguarded', async () => {
    await refuses({ method: 'PUT', url: '/a1', body: { name: 'x', baseVersion: '3' } }, 'body.baseVersion');
});

test('organizationId and sharedGroups are accepted and change nothing', async () => {
    // The legacy designer panel sends both. Moving an agent between orgs and
    // choosing its audience have their own doors; this one reuses the row.
    stored = { ...STORED_ROW, shared_groups: ['legal'] };
    const res = await put({ name: 'x', organizationId: 'orgB', sharedGroups: [] });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(saved().organizationId, 'orgA');
    assert.deepStrictEqual(saved().sharedGroups, ['legal']);
});

test('a save without a persona key still leaves the persona column alone', async () => {
    // `hasOwnProperty(req.body, 'persona')` decides it, and the parsed body
    // must not grow a `persona` key it never had.
    await put({ name: 'x' });
    assert.strictEqual(saved().opts.persona, undefined);
});

// ── Every body a real client sends ────────────────────────────────────
//
// Taken from the code that sends them. A key missing from the schema would
// 400 every save from that screen, so each one is sent here as it is built.

test('agent-hub BuilderSplit autosave (AgentWizard/state/agentSaveApi.js) saves', async () => {
    const res = await put({
        name: 'Contract reader', description: 'Reads supplier contracts', systemPrompt: 'Read the contract.',
        model: '', categoryId: null, embedEnabled: false, avatar: '📄',
        config: { memoryEnabled: true, knowledge_base_ids: [] }, persona: undefined, baseVersion: 7,
    });
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    assert.strictEqual(saved().opts.expectedRev, 7);
    assert.deepStrictEqual(flagsOf(saved()), ALL_OFF);
});

test('agent-hub AgentDesignerPanel save saves', async () => {
    const res = await put({
        name: 'Contract reader', description: '', avatar: '', systemPrompt: 'Read the contract.',
        tools: ['web_search'], toolParams: { web_search: { region: 'nl' } }, model: null,
        starterPrompts: ['Summarise this contract'], workspaceEnabled: 0, copyEnabled: true,
        embedEnabled: false, organizationId: null, sharedGroups: [], categoryId: null, config: {},
    });
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    assert.deepStrictEqual(touched.find((t) => t.what === 'setAgentTools').args.slice(0, 2), ['a1', ['web_search']]);
});

test('agent-hub AgentDesigner (useAgentApi) save saves', async () => {
    const res = await put({
        name: 'Contract reader', description: 'Reads supplier contracts', systemPrompt: 'Read the contract.',
        tools: [], toolParams: { web_search: { region: { value: 'nl', fixed: true } } },
        model: null, starterPrompts: [], avatar: '🤖', workspaceEnabled: 1, embedEnabled: false,
        config: {
            enableGuardrails: false, llamaGuardEnabled: false, webSearchGuardEnabled: false,
            strictKnowledge: false, includeSourceReferences: false, disableExternalTools: false,
            knowledge_base_ids: [],
            regexGuardrails: { enabled: false, collectionIds: [], scope: { userInput: true }, action: 'delete' },
        },
        categoryId: null,
    });
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
});

test('agent-hub KnowledgeStudio "accept suggestion" ({ config } alone) saves and changes nothing else', async () => {
    const res = await put({ config: { knowledge_base_ids: [] } });
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    const s = saved();
    assert.strictEqual(s.name, 'Contract reader');
    assert.strictEqual(s.description, 'Reads supplier contracts');
    assert.strictEqual(s.systemPrompt, 'Read the contract.');
    assert.deepStrictEqual(flagsOf(s), ALL_OFF);
});
