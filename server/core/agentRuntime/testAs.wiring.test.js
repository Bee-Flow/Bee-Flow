'use strict';

/**
 * The seam: is the simulation actually applied, and — just as important — is
 * it applied NOWHERE ELSE.
 *
 * `testAs.test.js` proves the rules. A rule nobody calls is worth nothing, and
 * this feature has FOUR doors into the same turn's knowledge:
 *
 *   1. the auto-injected knowledge search   (`performKnowledgeSearch`)
 *   2. the `kb_search` TOOL                 (the model asking for more)
 *   3. a project thread's own bases         (`injectProjectAndKnowledgeContext`)
 *   4. the runtime's own confirmation event (so the label is not client-side)
 *
 * Closing three of them is not a preview: the model would simply fetch back
 * through the tool exactly what the injection just hid, cite it, and the
 * editor would read that as "yes, Sales sees this". Each door is OPENED here
 * — the real function, a fake knowledge table, a recording retrieval stack —
 * because the previous version of this file pinned the ends of that chain
 * with regexes and the middle was missing for weeks while every one of them
 * stayed green (see core/tools/toolDispatcher.testAs.test.js).
 *
 * The other half is a boundary. "Test als" simulates group membership for
 * knowledge and audience, and the plan is explicit that it is NOT impersonation
 * of connections or permissions. That is a claim about files that do not
 * mention it, so it is asserted about files that do not mention it — the one
 * assertion here that stays textual, and the reason is on it. If you are
 * here because it failed, the question to answer first is not "how do I get
 * this green" but "does a simulated group id belong in a decision about
 * somebody's rights" — and the answer the plan gives is no.
 *
 * Run: cd server && node --test --test-force-exit core/agentRuntime/testAs.wiring.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('module');

const KBS = {
    open: { id: 'open', tenant_id: 'owner', organization_id: 'org1', is_published: true, shared_groups: '[]' },
    sales: { id: 'sales', tenant_id: 'owner', organization_id: 'org1', is_published: true, shared_groups: '["g_sales"]' },
    mine: { id: 'mine', tenant_id: 'u_asker', organization_id: null, is_published: true, shared_groups: '[]' },
};

let USER = { id: 'u_asker', organizationId: 'org1', groups: ['g_sales'] };
// The agent's owner, so the embed branch below has a real fallback identity to
// answer with — otherwise it comes back empty for the wrong reason and the
// assertion that a visitor cannot be simulated proves nothing.
const OWNER = { id: 'owner', organizationId: 'org1', groups: [] };

const realStore = require('../../stores/knowledgeBases');

const MOCKS = {
    '../../stores/userStore': {
        getUser: async (id) => (id === USER.id ? USER : (id === OWNER.id ? OWNER : null)),
    },
    '../../stores/knowledgeBases': {
        getKB: async (id) => KBS[id] || null,
        canUserAccessKB: realStore.canUserAccessKB,
    },
    // askerContext resolves group membership through the auth barrel; the real
    // one reads the database.
    '../../auth': {
        resolveUserGroups: async (id) => (id === USER.id && Array.isArray(USER.groups) ? USER.groups : []),
    },
};
const IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const id = `mock:testas-wiring:${request}`;
    IDS[request] = id;
    require.cache[id] = { id, filename: id, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    // kbVisibility and askerContext are the two modules that reach the stores;
    // testAs itself only reaches them.
    if (parent && /(kbVisibility|askerContext)\.js$/.test(parent.filename)) {
        if (request === '../../stores/knowledgeBases') return IDS['../../stores/knowledgeBases'];
        if (request === '../../stores/userStore') return IDS['../../stores/userStore'];
        if (request === '../../auth') return IDS['../../auth'];
    }
    return originalResolve.call(this, request, parent, ...rest);
};
test.after(() => { Module._resolveFilename = originalResolve; });

// ── The retrieval stack behind every door, as a recorder ─────────────
// Replaced WHOLESALE in require.cache rather than through the resolver patch
// above: Node caches a relative resolution per (directory, request), so a
// parent-scoped patch reaches only whichever module in a directory asked
// first — and several modules here share the same relative paths.
const SEARCHED = [];
const swap = (rel, exports) => {
    const file = require.resolve(path.join(__dirname, rel));
    require.cache[file] = { id: file, filename: file, loaded: true, exports, children: [], paths: [] };
};
swap('../kb/resolveProvider', { resolveKbProvider: async () => 'local' });
swap('../kb/localKBIngest', {
    searchLocally: async (userId, kbIds, query) => { SEARCHED.push({ userId, kbIds: [...kbIds], query }); return []; },
});
swap('../agentRuntime/kbQueryCache', { get: () => null, set: () => {} });

const { visibleKbIdsForTurn, performKnowledgeSearch } = require('./knowledgeSearch');

const AGENT = { id: 'a1', owner_id: 'owner', organization_id: 'org1', config: { knowledge_base_ids: ['open', 'sales', 'mine'] } };
const SIMULATE_MARKETING = { groupId: 'g_marketing', orgId: 'org1' };
// The row `setupTurn` loads, so one test can swap in a published agent.
const AGENT_FOR_RUNTIME = { row: AGENT };

// ── 1. Door one: the auto-injected knowledge ─────────────────────────

test('the turn filter narrows to the simulated group', async () => {
    USER = { id: 'u_asker', organizationId: 'org1', groups: ['g_sales'] };
    const all = await visibleKbIdsForTurn(['open', 'sales', 'mine'], { agent: AGENT, userId: 'u_asker' });
    assert.deepStrictEqual(all, ['open', 'sales', 'mine']);

    const asMarketing = await visibleKbIdsForTurn(['open', 'sales', 'mine'], {
        agent: AGENT, userId: 'u_asker', testAs: SIMULATE_MARKETING,
    });
    assert.deepStrictEqual(asMarketing, ['open'], 'the Sales base and the personal base are not Marketing\'s');
});

test('the turn filter cannot be used to reach a base the asker may not read', async () => {
    USER = { id: 'u_asker', organizationId: 'org1', groups: [] };
    const asSales = await visibleKbIdsForTurn(['open', 'sales'], {
        agent: AGENT, userId: 'u_asker', testAs: { groupId: 'g_sales', orgId: 'org1' },
    });
    assert.deepStrictEqual(asSales, ['open']);
});

test('an embed visitor cannot be simulated — the owner does not stand in for a group', async () => {
    // There is no identity to narrow on that path, and answering as the OWNER
    // under a group's label is the widest possible reading of a request that
    // only ever narrows. The control below is what that path returns WITHOUT a
    // simulation, so the empty answer is the guard talking and not the fixture.
    const control = await visibleKbIdsForTurn(['open'], { agent: AGENT, userId: null });
    assert.deepStrictEqual(control, ['open']);

    const out = await visibleKbIdsForTurn(['open'], {
        agent: AGENT, userId: null, testAs: { groupId: 'g_sales', orgId: 'org1' },
    });
    assert.deepStrictEqual(out, []);
});

test('the knowledge phase searches only what the simulation left', async () => {
    // `visibleKbIdsForTurn` is exercised above; this is the one line between it
    // and `performKnowledgeSearch`, and nothing else would notice it going
    // missing — the turn would simply inject the base the preview just hid.
    USER = { id: 'u_asker', organizationId: 'org1', groups: ['g_sales'] };
    SEARCHED.length = 0;
    await performKnowledgeSearch({ agent: AGENT, userId: 'u_asker', userMessage: 'Wat staat er over de marges?' });
    assert.deepStrictEqual(SEARCHED.at(-1).kbIds, ['open', 'sales', 'mine'], 'the asker sees everything they may read');

    SEARCHED.length = 0;
    await performKnowledgeSearch({ agent: AGENT, userId: 'u_asker', userMessage: 'Wat staat er over de marges?', testAs: SIMULATE_MARKETING });
    assert.deepStrictEqual(SEARCHED.map((s) => s.kbIds), [['open']], 'and Marketing sees one base');
});

// ── 2. Door two: the kb_search TOOL ──────────────────────────────────

test('the kb_search TOOL goes through the same filter, with the turn\'s simulation', async () => {
    // Narrowing the injection and leaving the tool open is worse than
    // narrowing neither: the model fetches back exactly what the preview hid
    // and cites it, and the editor reads that as "yes, Marketing sees this".
    swap('../../stores/agentStore', { getForRuntime: async () => AGENT });
    const { executeKbSearchTool } = require('../../integrations/kbSearchTools');
    USER = { id: 'u_asker', organizationId: 'org1', groups: ['g_sales'] };

    SEARCHED.length = 0;
    await executeKbSearchTool('kb_search', { query: 'marges per kwartaal' }, { userId: 'u_asker', agentId: 'a1' });
    assert.deepStrictEqual(SEARCHED.at(-1).kbIds, ['open', 'sales', 'mine']);

    SEARCHED.length = 0;
    const narrowed = await executeKbSearchTool('kb_search', { query: 'marges per kwartaal' },
        { userId: 'u_asker', agentId: 'a1', testAs: SIMULATE_MARKETING });
    assert.deepStrictEqual(SEARCHED.map((s) => s.kbIds), [['open']]);
    assert.ok(narrowed, 'and the tool still answers — it narrows, it does not error');

    // A simulation the runtime cannot read takes ALL the knowledge away rather
    // than falling back to the real person's.
    SEARCHED.length = 0;
    const unreadable = await executeKbSearchTool('kb_search', { query: 'marges per kwartaal' },
        { userId: 'u_asker', agentId: 'a1', testAs: { groupId: '', orgId: 'org1' } });
    assert.deepStrictEqual(SEARCHED, [], 'nothing was searched');
    assert.match(unreadable.message, /No knowledge base/);
});

// ── 3. Door three: a project thread's own bases ──────────────────────

test('the project-thread door is narrowed too', async () => {
    // A preview that hides a group-restricted base from the agent's own
    // knowledge and then quotes it back out of the project's is not a preview
    // of anything.
    const searchedByProject = [];
    const knowledgeSearchFile = require.resolve(path.join(__dirname, 'knowledgeSearch.js'));
    const realKnowledgeSearch = require.cache[knowledgeSearchFile].exports;
    require.cache[knowledgeSearchFile] = {
        id: knowledgeSearchFile, filename: knowledgeSearchFile, loaded: true, children: [], paths: [],
        exports: { ...realKnowledgeSearch, quickKBSearch: async (_userId, kbIds) => { searchedByProject.push([...kbIds]); return []; } },
    };
    try {
        const { injectProjectAndKnowledgeContext } = require('./contextEnrichment');
        USER = { id: 'u_asker', organizationId: 'org1', groups: ['g_sales'] };
        const project = { name: 'Marges', customInstructions: '', knowledgeBaseIds: ['open', 'sales'] };
        const args = {
            agent: AGENT, userId: 'u_asker', userMessage: 'Wat staat er over de marges?', userAuth: {},
            validProject: project, systemPrompt: '', volatileSystemPrompt: '', _kbSources: [], tools: [],
        };
        await injectProjectAndKnowledgeContext({ ...args });
        await injectProjectAndKnowledgeContext({ ...args, testAs: SIMULATE_MARKETING });
        assert.deepStrictEqual(searchedByProject, [['open', 'sales'], ['open']],
            'a project\'s bases must not slip past the simulation');
    } finally {
        require.cache[knowledgeSearchFile] = {
            id: knowledgeSearchFile, filename: knowledgeSearchFile, loaded: true, children: [], paths: [],
            exports: realKnowledgeSearch,
        };
    }
});

// ── 4. Door four: the runtime says what it actually did ──────────────

test('the runtime, not the client, says whether a turn was simulated', async () => {
    // A client that labels a turn from what it SENT would call a turn with no
    // knowledge at all "as Marketing". `setupTurn` is where the runtime says
    // what it loaded; it is driven here with its six collaborators replaced.
    swap('../aiAgent', { getAIConfig: async () => ({}), getProviderForModel: async () => ({ providerType: 'claude', providerName: 'claude', url: 'u', apiKey: 'k' }) });
    swap('../../stores/agentStore', { getForRuntime: async () => AGENT_FOR_RUNTIME.row });
    swap('./modelResolver', { resolveAgentModel: async () => 'claude-x' });
    swap('./toolStackAssembly', { assembleToolStack: async () => ({ tools: [], disableExternalTools: true }) });
    swap('./sharedThread', { setupSharedThreadTurnLock: async () => ({ _sharedThread: null }) });
    const { setupTurn } = require('./chatStream/turnSetup');

    const run = async (testAs, agent = AGENT) => {
        const events = [];
        AGENT_FOR_RUNTIME.row = agent;
        await setupTurn({
            agentId: 'a1', userId: 'u_asker', userMessage: 'hoi', userAuth: {},
            onEvent: (event, data) => events.push({ event, data }),
            messageMetadata: { ephemeral: true, orgId: 'org1', ...(testAs ? { testAs } : {}) },
            _pendingTurnReleases: [], _turnCallId: 't1',
        });
        AGENT_FOR_RUNTIME.row = AGENT;
        return events.filter((e) => e.event === 'test_as');
    };

    assert.deepStrictEqual(await run(null), [], 'an ordinary turn says nothing');

    // The audience half: could a member of that group open this agent at all?
    // Reported, never enforced — and answered about the GROUP, not about the
    // editor, who usually owns the draft they are previewing.
    assert.deepStrictEqual(await run({ groupId: 'g_marketing', groupName: 'Marketing', orgId: 'org1' }), [{
        event: 'test_as',
        data: { active: true, groupId: 'g_marketing', groupName: 'Marketing', audience: { visible: false, reason: 'unpublished' } },
    }], 'an unpublished agent is not reachable by a group, however much its owner can see it');

    const published = { ...AGENT, is_published: true, audience: 'organization' };
    assert.deepStrictEqual((await run({ groupId: 'g_marketing', orgId: 'org1' }, published))[0].data.audience,
        { visible: true, reason: 'ok' });

    assert.deepStrictEqual(await run({ groupId: '   ', orgId: 'org1' }), [{
        event: 'test_as', data: { active: false, unreadable: true },
    }], 'a simulation the runtime could not read is a turn with no knowledge, and it says so');
});

test('the pre-flight hands the turn\'s simulation to the knowledge phase', async () => {
    // The hop between the request's metadata and door one. Both ends of it
    // were once pinned with regexes while the middle was missing.
    const seen = [];
    swap('./contextEnrichment', {
        resolveMemoryContext: async () => ({ systemPrompt: '', volatileSystemPrompt: '' }),
        injectProjectAndKnowledgeContext: async ({ testAs, systemPrompt, volatileSystemPrompt }) => {
            seen.push(testAs);
            return { systemPrompt, volatileSystemPrompt };
        },
    });
    swap('../privacy/orgShield', { resolveShieldFor: async () => null });
    swap('./contextBuilder', { buildSystemPrompt: async () => ({ systemPrompt: 'SYS', volatileSystemPrompt: '' }) });
    swap('./guardrailsRunner', { runInputGuardrails: async ({ userMessage }) => ({ processedUserMessage: userMessage }) });
    swap('./streamUntokeniser', { createUntokenisingEventWrapper: (onEvent) => onEvent });
    const { runTurnPreflight } = require('./chatStream/turnPreflight');

    const run = (testAs) => runTurnPreflight({
        agent: AGENT, agentId: 'a1', userId: 'u_asker', userMessage: 'hoi', userAuth: {},
        messageMetadata: { ephemeral: true, ...(testAs ? { testAs } : {}) },
        globalConfig: {}, config: { providerType: 'claude', url: 'u' }, modelToUse: 'claude-x',
        conversation: { id: 'c1', messages: [] }, messages: [{ role: 'user', content: 'hoi' }],
        tools: [], validProjectId: null, validProject: null, isStandardTier: false,
        onEvent: () => {}, userSave: null, promptUserMsg: { role: 'user', content: 'hoi' },
    });

    await run(null);
    await run(SIMULATE_MARKETING);
    assert.deepStrictEqual(seen, [null, SIMULATE_MARKETING],
        'absent is an explicit null, so a metadata key nobody set cannot read as a simulation');
});

// ── 5. The boundary ──────────────────────────────────────────────────

test('the non-streaming chat path has no metadata channel to ignore one on', () => {
    // `chatWithAgent` takes no messageMetadata at all, so there is no way to
    // hand it a simulation it would silently drop. Read off the LIVE function
    // rather than the file: it is a claim about the function's shape, and it
    // survives the module moving. If that signature grows a metadata argument,
    // this test is where you decide what a `testAs` on it means.
    const { chatWithAgent } = require('./chatWithAgent');
    const params = /\(([^)]*)\)/.exec(chatWithAgent.toString())[1].split(',').map((s) => s.trim().split('=')[0].trim());
    assert.deepStrictEqual(params, ['agentId', 'userId', 'userMessage', 'userAuth']);
});

// A trailing slash is a FOLDER: every module in it is read, not just its entry
// point — toolPolicy is a folder now, and what this asserts about it lives in
// the siblings as much as in index.js.
const readAll = (rel) => (rel.endsWith('/')
    ? fs.readdirSync(path.join(__dirname, rel)).filter(f => f.endsWith('.js')).map(f => fs.readFileSync(path.join(__dirname, rel + f), 'utf8')).join('\n')
    : fs.readFileSync(path.join(__dirname, rel), 'utf8'));

test('the simulation never reaches a decision about rights, connections or entitlements', () => {
    // THE ONE ASSERTION HERE THAT STAYS TEXTUAL, and on purpose: it is a claim
    // about code that does not exist. No test can drive a call that is not
    // there, and enumerating the branches of seven modules to show a simulated
    // group changes none of them would be a suite that goes stale the week
    // somebody adds the eighth. A folder scan covers every module in it,
    // including the ones nothing here drives, and it is the cheapest true
    // statement of the rule.
    //
    // The plan: "geen impersonatie van verbindingen of permissies". A group id
    // somebody typed into a preview must not be able to change who a tool acts
    // as, which actions are allowed, which rows a datatable returns, or what a
    // licence permits.
    const FORBIDDEN = [
        ['./toolPolicy/', 'which actions an agent may call, and as whom'],
        ['./toolStackAssembly.js', 'which tools reach the model, and the connection policy'],
        ['../integrations/integrationTools.js', 'connection lending'],
        ['../tools/datatableTools.js', 'which ROWS somebody may read'],
        ['../../auth/datatableAccess.js', 'datatable grades'],
        ['../../automation/agentCallableTools.js', 'who owns a routine'],
        ['../../auth/permissions.js', 'permissions and org membership'],
    ];
    for (const [rel, why] of FORBIDDEN) {
        assert.doesNotMatch(readAll(rel), /testAs/, `${rel} decides ${why} — a simulated group has no business there`);
    }
});
