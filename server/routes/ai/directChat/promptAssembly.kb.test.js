/**
 * The direct-chat turn's knowledge-base gate.
 *
 * This block IS the whole KB security of direct chat and it had no test at
 * all: whatever ids reach `quickKBSearch` here get searched, because
 * core/localKBIngest does no tenant filtering of its own — the id list is its
 * access boundary. So this file pins the two things that must stay true:
 *
 *   1. NOTHING REACHES RETRIEVAL UNCHECKED. Only ids that survived
 *      `core/kb/kbSelection.resolveUsableKbIds` (kbVisibility + usage_contexts)
 *      are handed to the search, and a refused id is dropped silently — the
 *      asker is never told a base exists that they may not see.
 *
 *   2. THE STORED COLUMN IS NEVER READ BACK INTO A TURN. What this turn may
 *      search comes from the REQUEST. `direct_conversations.knowledge_base_ids`
 *      exists so the composer can restore a selection, and reading it here
 *      would be the fail-open that matters: today's web and mobile clients OMIT
 *      the key when the list is empty, so "no key → fall back to the stored
 *      list" turns "I unticked every base" into "keep answering from them",
 *      with an empty picker and citations in the reply.
 *
 * The whole module is exercised with its 19 dependencies cut at the require
 * seam, so the code under test is the real buildPromptAndHistory.
 *
 * Run: cd server && node --test --test-force-exit routes/ai/directChat/promptAssembly.kb.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

process.env.NODE_ENV = 'test';

// ── Mutable fixtures ─────────────────────────────────────────────────
const fx = {
    /** What the KB policy says this asker may search. Everything else is refused. */
    allowed: [],
    /** Every resolveUsableKbIds call: proves the policy is consulted at all. */
    policyCalls: [],
    /** Every quickKBSearch call: proves WHAT reached retrieval. */
    searchCalls: [],
    /** Chunks the search hands back. */
    chunks: [],
    /** The stored conversation — its knowledgeBaseIds must never be used for a turn. */
    conversation: null,
    project: null,
    /** The resolved shield the turn's KB strip reads (BFSF-354). */
    shield: null,
    /** Every side-panel document lookup the turn made. */
    documentCalls: [],
    /** What the memory gate answers, and what it was asked / what the store was asked. */
    memoryPolicy: { read: true, write: true, reason: 'enabled' },
    memoryPolicyCalls: [],
    memoryStoreCalls: 0,
    memoryStoreArgs: null,
};

const noop = () => {};

const MOCKS = {
    '../../../stores/configStore': { getConfig: async () => null },
    '../../../core/aiAgent': { getAIConfig: async () => ({ piiDetectionEnabled: false }) },
    '../../../stores/agentStore': {
        getDirectConversation: async () => (fx.conversation ? { ...fx.conversation } : null),
    },
    '../../../stores/userStore': {
        getUser: async () => ({ id: 'alice', groups: [], organizationId: 'org-1' }),
        getOrganization: async () => null,
    },
    '../../../core/integrations/integrationTools': { buildToolHint: async () => '' },
    '../../../core/agentRuntime/phaseEvents': { emitPhase: noop, emitPhaseEnd: noop, withPhase: async (s, p, fn) => fn() },
    './systemPrompt': { DEFAULT_SYSTEM_PROMPT: 'You are a helpful assistant.' },
    './shared': { encryptionOpts: () => ({}) },
    '../../../core/llm/promptStyle': { buildWritingStyleAddendum: () => '', buildResponseLanguageRule: () => '' },
    '../../../auth/projectAccess': {
        resolveRequestedProject: async (userId, projectId) => (fx.project && fx.project.projectId === projectId ? fx.project : null),
    },
    '../../../core/agentRuntime/knowledgeSearch': {
        quickKBSearch: async (userId, kbIds, message) => {
            fx.searchCalls.push({ userId, kbIds: [...kbIds], message });
            return fx.chunks;
        },
    },
    '../../../core/kb/kbSelection': {
        // A recording stand-in for the policy. Its own refusal behaviour is
        // pinned in core/kb/kbSelection.test.js against the REAL
        // canUserAccessKB; what matters here is that the turn asks it, and
        // uses only what it answers.
        resolveUsableKbIds: async (ids, opts) => {
            fx.policyCalls.push({ ids: [...(ids || [])], opts });
            return (ids || []).filter(id => fx.allowed.includes(id));
        },
    },
    '../../../stores/memoryStore': {
        findRelevantMemories: async (...a) => { fx.memoryStoreCalls++; fx.memoryStoreArgs = a; return [{ id: 'm1', type: 'fact', content: 'likes tea' }]; },
        formatMemoriesForPrompt: () => '## Active Memory\n- likes tea',
    },
    '../../../core/memory/memoryPolicy': {
        resolveMemoryPolicy: async (opts) => { fx.memoryPolicyCalls.push(opts); return fx.memoryPolicy; },
    },
    '../../../core/memory/scrubMemoryContext': { scrubMemoryContext: async (t) => ({ scrubbed: t, replacedCategories: [] }) },
    '../../../stores/houseStyleStore': { getDefaultForOrg: async () => null },
    '../../../core/webpages/sidePanelWebpageContext': { buildSidePanelWebpageContext: async () => '' },
    '../../../core/documents/sidePanelDocumentContext': {
        buildDirectNote: async (panel, userId) => {
            fx.documentCalls.push({ panel, userId });
            return panel && panel.id === 'doc1' ? '\n\n[DOCUMENT OPEN] The user has "Offerte" (documentId: doc1, type: quote) open next to the chat.' : '';
        },
    },
    '../../../core/tools/skillInjection': {
        buildSkillInjection: async () => ({ systemPromptAddendum: '', tools: [], staticCount: 0, dynamicSkillIds: [] }),
    },
    '../../../core/conversation/historyMerge': { mergeAttachmentSidecars: (m) => m },
    '../../../core/privacy/orgShield': { resolveShieldFor: async () => fx.shield },
    '../../../core/agentRuntime/historyHydrator': { hydrateHistoryAttachments: async () => {} },
};

const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:prompt-assembly-kb:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /directChat[\\/]promptAssembly\.js$/.test(parent.filename)
        && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const { buildPromptAndHistory } = require('./promptAssembly');

test.after(() => { Module._resolveFilename = originalResolve; });

function reset() {
    fx.allowed = [];
    fx.policyCalls.length = 0;
    fx.searchCalls.length = 0;
    fx.chunks = [];
    fx.conversation = null;
    fx.project = null;
    fx.shield = null;
    fx.documentCalls.length = 0;
    fx.memoryPolicy = { read: true, write: true, reason: 'enabled' };
    fx.memoryPolicyCalls.length = 0;
    fx.memoryStoreCalls = 0;
}

function runTurn(overrides = {}) {
    return buildPromptAndHistory({
        req: { session: { user: { id: 'alice' } } },
        send: noop,
        userId: 'alice',
        message: 'what is our refund policy?',
        conversationId: 'c1',
        history: [],
        timezone: 'UTC',
        requestSystemPrompt: null,
        activeSkillIds: [],
        requestedKbIds: undefined,
        projectId: null,
        notebookspaceAvailable: false,
        notebookspaceContent: '',
        notebookspaceSelection: '',
        sidePanelWebpage: null,
        webpagePlanExecution: null,
        userOrgForTiers: 'org-1',
        orgIdsForTiers: new Set(['org-1']),
        notebooksEnabled: false,
        canUseNotebooks: false,
        toolCatalogText: '',
        directChatTools: [],
        ...overrides,
    });
}

/** The system text the model will actually see. */
function promptText(state) {
    return JSON.stringify(state.messages);
}

// ═══ 1. Nothing reaches retrieval unchecked ══════════════════════

test('the ids the client named are put to the policy before anything is searched', async () => {
    reset();
    fx.allowed = ['kb-ok'];
    const state = await runTurn({ requestedKbIds: ['kb-ok'] });

    assert.strictEqual(fx.policyCalls.length, 1, 'the policy must be consulted');
    assert.deepStrictEqual(fx.policyCalls[0].ids, ['kb-ok']);
    assert.strictEqual(fx.policyCalls[0].opts.userId, 'alice', 'the ASKER is who the policy evaluates');
    assert.strictEqual(fx.policyCalls[0].opts.surface, 'direct_chat');
    assert.ok(fx.policyCalls[0].opts.orgIds instanceof Set, 'orgIds must be a Set — a null reads as super admin');
    assert.deepStrictEqual(state.usableKbIds, ['kb-ok']);
});

test('a refused id never reaches the search, and does not take the allowed ones with it', async () => {
    reset();
    fx.allowed = ['kb-ok'];
    fx.chunks = [{ content: 'refunds within 30 days', title: 'Policy' }];
    const state = await runTurn({ requestedKbIds: ['kb-ok', 'kb-secret'] });

    assert.strictEqual(fx.searchCalls.length, 1);
    assert.deepStrictEqual(fx.searchCalls[0].kbIds, ['kb-ok'], 'only the survivors may be searched');
    assert.deepStrictEqual(state.usableKbIds, ['kb-ok']);
});

test('when every id is refused, nothing is searched at all', async () => {
    reset();
    fx.allowed = [];
    const state = await runTurn({ requestedKbIds: ['kb-secret', 'kb-other-org'] });

    assert.deepStrictEqual(fx.searchCalls, [], 'a refused list must not become an empty-list search');
    assert.deepStrictEqual(state.usableKbIds, []);
});

test('the asker is never told a base was refused', async () => {
    reset();
    fx.allowed = [];
    const state = await runTurn({ requestedKbIds: ['kb-secret'] });
    // Naming it in the prompt would tell the person a base exists, roughly what
    // it is about, and that somebody they know has it.
    assert.ok(!promptText(state).includes('kb-secret'));
});

test('a base that survives actually contributes — this is not passing by doing nothing', async () => {
    reset();
    fx.allowed = ['kb-ok'];
    fx.chunks = [{ content: 'refunds within 30 days', title: 'Policy' }];
    const state = await runTurn({ requestedKbIds: ['kb-ok'] });
    assert.ok(promptText(state).includes('refunds within 30 days'));
    assert.ok(promptText(state).includes('ATTACHED KNOWLEDGE BASES'));
});

// ═══ 2. The stored column is never read back into a turn ═════════

test('an omitted key means NO knowledge bases — never "re-use what is stored"', async () => {
    reset();
    fx.allowed = ['kb-stored'];
    // The conversation has a base attached and the client sent no key at all,
    // which is exactly what today's clients do when the user unticks
    // everything.
    fx.conversation = { id: 'c1', user_id: 'alice', messages: [], knowledgeBaseIds: ['kb-stored'], knowledge_base_ids: ['kb-stored'] };

    const state = await runTurn({ requestedKbIds: undefined });

    assert.deepStrictEqual(fx.policyCalls, [], 'nothing to check: the request named nothing');
    assert.deepStrictEqual(fx.searchCalls, [], 'the stored list must not become this turn\'s search');
    assert.deepStrictEqual(state.usableKbIds, []);
    assert.ok(!promptText(state).includes('kb-stored'));
});

test('an explicitly empty list is honoured just as literally', async () => {
    reset();
    fx.allowed = ['kb-stored'];
    fx.conversation = { id: 'c1', user_id: 'alice', messages: [], knowledgeBaseIds: ['kb-stored'], knowledge_base_ids: ['kb-stored'] };

    const state = await runTurn({ requestedKbIds: [] });

    assert.deepStrictEqual(fx.searchCalls, []);
    assert.deepStrictEqual(state.usableKbIds, []);
});

test('junk in place of a list searches nothing rather than everything', async () => {
    reset();
    fx.allowed = ['kb-a'];
    for (const bad of [null, 'kb-a', { kb: 'kb-a' }, 42]) {
        fx.searchCalls.length = 0;
        const state = await runTurn({ requestedKbIds: bad });
        assert.deepStrictEqual(fx.searchCalls, [], `input: ${JSON.stringify(bad)}`);
        assert.deepStrictEqual(state.usableKbIds, []);
    }
});

// ═══ 3. What the turn reports back for persistence ═══════════════

test('usableKbIds is what gets persisted — never the raw client list', async () => {
    reset();
    fx.allowed = ['kb-ok'];
    const state = await runTurn({ requestedKbIds: ['kb-ok', 'kb-secret', 'kb-ghost'] });
    // finalizeTurn stores exactly this, so the column can only ever hold ids
    // this person was authorised to search at the moment it was written.
    assert.deepStrictEqual(state.usableKbIds, ['kb-ok']);
});

test('a search that blows up does not silently detach the bases the person picked', async () => {
    reset();
    fx.allowed = ['kb-ok'];
    const brokenSearch = MOCKS['../../../core/agentRuntime/knowledgeSearch'].quickKBSearch;
    MOCKS['../../../core/agentRuntime/knowledgeSearch'].quickKBSearch = async () => { throw new Error('index unavailable'); };
    try {
        const state = await runTurn({ requestedKbIds: ['kb-ok'] });
        // Retrieval failing is not an authorisation failure: the selection
        // stays, so a transient outage does not quietly empty the picker.
        assert.deepStrictEqual(state.usableKbIds, ['kb-ok']);
    } finally {
        MOCKS['../../../core/agentRuntime/knowledgeSearch'].quickKBSearch = brokenSearch;
    }
});

// ═══ 4. Project knowledge bases are a SEPARATE source ════════════

test('a project\'s own bases are not folded into the chat\'s attached list', async () => {
    reset();
    fx.allowed = ['kb-chat'];
    fx.project = {
        projectId: 'p1',
        project: { name: 'Acme', knowledgeBaseIds: ['kb-project'], extractMemories: false, customInstructions: '' },
    };
    const state = await runTurn({ requestedKbIds: ['kb-chat'], projectId: 'p1' });

    // Both sources reach retrieval, but only the chat's own list is what gets
    // stored on the conversation. A pill built from `usableKbIds` therefore
    // speaks only for "attached to this chat" — it must not claim to be the
    // whole answer to "where did this come from".
    assert.deepStrictEqual(state.usableKbIds, ['kb-chat']);
    const searched = fx.searchCalls.map(c => c.kbIds);
    assert.ok(searched.some(ids => ids.includes('kb-project')), 'the project source still runs');
    assert.ok(searched.some(ids => ids.includes('kb-chat')));
});

// ═══ BFSF-354: the "own server" block list reaches injected passages ══
//
// Passages injected without a tool call reached the model unfiltered, while
// the same passages fetched through kb_search were stripped. The detector is
// injected into the real gate; synthetic data.

const toolPiiGate = require('../../../core/privacy/toolPiiGate');
const SYNTH_EMAIL = 'someone@example.test';
const OWN_SERVER_EMAIL = {
    enabled: true,
    toolPiiPolicy: { external: { blockCategories: [] }, internal: { blockCategories: ['Email'] } },
};
const detectCalls = [];
toolPiiGate._deps.detectPii = async (text, categories) => {
    detectCalls.push({ text, categories });
    const i = String(text).indexOf(SYNTH_EMAIL);
    if (i < 0 || !categories.includes('Email')) return { hasPii: false, entities: [] };
    return { hasPii: true, entities: [{ text: SYNTH_EMAIL, category: 'Email', label: 'Email Address', offset: i, length: SYNTH_EMAIL.length }] };
};

test('BFSF-354 a passage from an attached base loses what the own-server list blocks', async () => {
    reset();
    fx.allowed = ['kb-ok'];
    fx.shield = OWN_SERVER_EMAIL;
    fx.chunks = [{ content: `refunds: write to ${SYNTH_EMAIL}`, title: 'Policy' }];
    const state = await runTurn({ requestedKbIds: ['kb-ok'] });
    const text = promptText(state);
    assert.ok(!text.includes(SYNTH_EMAIL), 'the blocked value reached the prompt');
    assert.ok(text.includes('refunds: write to [blocked:email]'));
});

test('BFSF-354 the bases of a project get the same treatment', async () => {
    reset();
    fx.shield = OWN_SERVER_EMAIL;
    fx.project = {
        projectId: 'p1',
        project: { name: 'Acme', knowledgeBaseIds: ['kb-project'], extractMemories: false, customInstructions: '' },
    };
    fx.chunks = [{ content: `billing contact ${SYNTH_EMAIL}`, title: 'Billing' }];
    const state = await runTurn({ projectId: 'p1' });
    const text = promptText(state);
    assert.ok(!text.includes(SYNTH_EMAIL));
    assert.ok(text.includes('billing contact [blocked:email]'));
});

test('BFSF-354 without a shield, or without an own-server list, nothing is scanned', async () => {
    const outsideOnly = { enabled: true, toolPiiPolicy: { external: { blockCategories: ['Email'] }, internal: { blockCategories: [] } } };
    for (const shield of [null, outsideOnly]) {
        reset();
        detectCalls.length = 0;
        fx.allowed = ['kb-ok'];
        fx.shield = shield;
        fx.chunks = [{ content: `refunds: write to ${SYNTH_EMAIL}`, title: 'Policy' }];
        const state = await runTurn({ requestedKbIds: ['kb-ok'] });
        assert.strictEqual(detectCalls.length, 0);
        assert.ok(promptText(state).includes(SYNTH_EMAIL), 'with no own-server list the passage is untouched');
    }
});

test('BFSF-354 a title that carries a blocked value is stripped from the Source line too', async () => {
    reset();
    fx.allowed = ['kb-ok'];
    fx.shield = OWN_SERVER_EMAIL;
    fx.project = {
        projectId: 'p1',
        project: { name: 'Acme', knowledgeBaseIds: ['kb-project'], extractMemories: false, customInstructions: '' },
    };
    // An e-mail archive titles every message by its sender.
    fx.chunks = [{ content: 'the invoice is attached', title: `${SYNTH_EMAIL} — invoice` }];
    const state = await runTurn({ requestedKbIds: ['kb-ok'], projectId: 'p1' });
    const text = promptText(state);
    assert.ok(!text.includes(SYNTH_EMAIL), 'the blocked value reached the prompt through the source label');
    assert.ok(text.includes('### Source 1: [blocked:email] — invoice'));
    assert.ok(text.includes('PROJECT KNOWLEDGE BASE') && text.includes('ATTACHED KNOWLEDGE BASES'), 'both sites ran');
});

// ═══ Side-panel document ═════════════════════════════════════════

test('an open side-panel document is announced in the prompt, resolved for the asker', async () => {
    reset();
    const state = await runTurn({ sidePanelDocument: { id: 'doc1', name: 'x' } });
    assert.match(promptText(state), /\[DOCUMENT OPEN\] The user has \\"Offerte\\" \(documentId: doc1/);
    assert.deepStrictEqual(fx.documentCalls.map(c => c.userId), ['alice']);
});

test('no sidePanelDocument, no document block and no lookup; an unreadable one adds nothing', async () => {
    reset();
    const none = await runTurn({});
    assert.ok(!promptText(none).includes('DOCUMENT OPEN'));
    assert.strictEqual(fx.documentCalls.length, 0);
    const unreadable = await runTurn({ sidePanelDocument: { id: 'other' } });
    assert.ok(!promptText(unreadable).includes('DOCUMENT OPEN'));
});

// ═══ Memory gate ═════════════════════════════════════════════════

test('memory read off: the store is never asked and no memory reaches the prompt', async () => {
    reset();
    fx.memoryPolicy = { read: false, write: false, reason: 'org_disabled' };
    const state = await runTurn({ req: { session: { user: { id: 'alice' } }, body: { memoryReadEnabled: false } } });
    assert.strictEqual(fx.memoryStoreCalls, 0);
    assert.ok(!promptText(state).includes('likes tea'));
    assert.deepStrictEqual(state.memoryPolicy, fx.memoryPolicy, 'handed on for finalizeTurn');
    assert.deepStrictEqual(fx.memoryPolicyCalls[0], { userId: 'alice', orgId: 'org-1', perChatReadEnabled: false, perChatWriteEnabled: undefined });
});

test('memory read on: the memories are injected', async () => {
    reset();
    const state = await runTurn({});
    assert.strictEqual(fx.memoryStoreCalls, 1);
    assert.ok(promptText(state).includes('likes tea'));
});

test('memory read: art. 9 rows are asked for only when the policy says opted in', async () => {
    reset();
    await runTurn({});
    assert.deepStrictEqual(fx.memoryStoreArgs[5], { includeSensitive: false });
    reset();
    fx.memoryPolicy = { read: true, write: true, reason: 'enabled', sensitive: true };
    await runTurn({});
    assert.deepStrictEqual(fx.memoryStoreArgs[5], { includeSensitive: true });
});

// ═══ memory_used ═════════════════════════════════════════════════

test('memory_used is sent once, before the answer, and the list is handed to the turn state', async () => {
    reset();
    const events = [];
    const state = await runTurn({ send: (type, data) => events.push([type, data]) });
    const used = events.filter(([t]) => t === 'memory_used');
    assert.strictEqual(used.length, 1);
    assert.deepStrictEqual(used[0][1], { items: [{ id: 'm1', type: 'fact', preview: 'likes tea', why: 'relevant' }] });
    assert.deepStrictEqual(state.memoryUsed, used[0][1].items);
});

test('memory read off: no memory_used event and an empty list', async () => {
    reset();
    fx.memoryPolicy = { read: false, write: false, reason: 'chat_off' };
    const events = [];
    const state = await runTurn({ send: (type, data) => events.push([type, data]) });
    assert.ok(!events.some(([t]) => t === 'memory_used'));
    assert.deepStrictEqual(state.memoryUsed, []);
});
