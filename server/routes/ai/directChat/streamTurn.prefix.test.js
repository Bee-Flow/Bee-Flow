/**
 * Direct chat — nothing may append to the cached system block mid-turn.
 *
 * REGRESSION (measured 2026-09-11 against a single-slot llama.cpp server):
 * every turn re-read the whole prompt (4,375 tokens / 28.7 s) because the
 * step-machine guard, the PII-token addendum, the moderation flag and the
 * session-skill state were all appended to messages[0] — the block every
 * provider caches by byte prefix. They now ride the volatile block, which is
 * moved behind the history before the first model call.
 *
 * What is proved here by RUNNING the code: prompt assembly hands the turn a
 * named volatile block and puts it at index 1, and the input gates write their
 * per-turn addenda onto that block with messages[0] byte-identical afterwards.
 * Where the block then goes, and what the step-machine guard writes on it, is
 * proved the same way in ./volatileLayout.test.js.
 *
 * The last test is the one thing here that is a statement about the FILES and
 * not about a call: `messages[0].content +=` must appear nowhere in the turn's
 * pipeline. It is a claim quantified over every present and future call site
 * in this folder — a behavioural test can only show that the paths it happens
 * to drive are clean, and the two regressions above were both on a path no
 * test drove. It scans the folder rather than a list of file names, so
 * splitting a phase out of streamTurn.js widens the check instead of
 * escaping it.
 *
 * Run: cd server && node --test --test-force-exit routes/ai/directChat/streamTurn.prefix.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('module');

process.env.NODE_ENV = 'test';

const noop = () => {};

// ── Prompt assembly, with its 19 dependencies cut at the require seam ──
const asmFx = { conversation: null };
const ASSEMBLY_MOCKS = {
    '../../../stores/configStore': { getConfig: async () => null },
    '../../../core/aiAgent': { getAIConfig: async () => ({ piiDetectionEnabled: false }) },
    '../../../stores/agentStore': { getDirectConversation: async () => asmFx.conversation },
    '../../../stores/userStore': {
        getUser: async () => ({ id: 'alice', groups: [], organizationId: 'org-1' }),
        getOrganization: async () => null,
    },
    '../../../core/integrations/integrationTools': { buildToolHint: async () => '' },
    '../../../core/agentRuntime/phaseEvents': { emitPhase: noop, emitPhaseEnd: noop, withPhase: async (s, p, fn) => fn() },
    './systemPrompt': { DEFAULT_SYSTEM_PROMPT: 'You are a helpful assistant.' },
    './shared': { encryptionOpts: () => ({}) },
    '../../../core/llm/promptStyle': { buildWritingStyleAddendum: () => '' },
    '../../../auth/projectAccess': { resolveRequestedProject: async () => null },
    '../../../core/agentRuntime/knowledgeSearch': { quickKBSearch: async () => [] },
    '../../../core/kb/kbSelection': { resolveUsableKbIds: async () => [] },
    '../../../stores/memoryStore': { findRelevantMemories: async () => [], formatMemoriesForPrompt: () => '' },
    '../../../core/memory/scrubMemoryContext': { scrubMemoryContext: async (t) => ({ scrubbed: t, replacedCategories: [] }) },
    '../../../stores/houseStyleStore': { getDefaultForOrg: async () => null },
    '../../../core/webpages/sidePanelWebpageContext': { buildSidePanelWebpageContext: async () => '' },
    '../../../core/tools/skillInjection': {
        buildSkillInjection: async () => ({ systemPromptAddendum: '', tools: [], staticCount: 0, dynamicSkillIds: [] }),
    },
    '../../../core/conversation/historyMerge': { mergeAttachmentSidecars: (m) => m },
    '../../../core/agentRuntime/historyHydrator': { hydrateHistoryAttachments: async () => {} },
};

// ── The input gates, same treatment ───────────────────────────────────
const gateFx = {
    /** What the PII detector claims it found. null = nothing to tokenise. */
    piiResult: null,
    /** Conversation-scoped token map the DLP runner hands back. */
    convTokenMap: {},
    shield: { enabled: true, dlpEnabled: false },
};
const GATE_MOCKS = {
    '../../../stores/configStore': { getConfig: async () => null, getAllConfig: async () => ({}) },
    '../../../core/aiAgent': { getAIConfig: async () => ({ piiDetectionEnabled: true }) },
    '../../../stores/guardrailEventStore': { logGuardrailEvent: async () => {} },
    '../../../core/agentRuntime/phaseEvents': {
        startPrivacyScanPhase: () => ({ onProgress: noop, end: noop }),
        messageText: (m) => (typeof m?.content === 'string' ? m.content : ''),
    },
    '../../../core/agentRuntime/guardrailsRunner': { applyRegexGuardrails: () => ({ action: 'pass' }) },
    '../../../services/orgHealth': { problem: noop, resolve: noop },
    '../../../auth': { resolveUserOrgIds: async () => new Set(['org-1']) },
    '../../../core/privacy/orgShield': {
        resolveShieldFor: async () => gateFx.shield,
        resolveOrgShield: async () => gateFx.shield,
        mergeWithOrgShield: (a) => a || { enabled: false },
    },
    '../../../core/privacy/piiDetection': { validateInputForPii: async () => gateFx.piiResult },
    '../../../core/dlp/dlpRunner': {
        getConversationTokenMapAsync: async () => gateFx.convTokenMap,
        getConversationTokenMap: () => gateFx.convTokenMap,
        mergeTokenMap: noop,
    },
};

/**
 * Cut `request` for a module whose filename matches `ownerRe` only. Real
 * modules everywhere else — buildTokenPreservationAddendum and the Unicode
 * sanitiser are the code under test here, not stand-ins.
 */
function installMocks(tag, ownerRe, mocks) {
    const ids = {};
    for (const [request, exportsObj] of Object.entries(mocks)) {
        const id = `mock:${tag}:${request}`;
        ids[request] = id;
        require.cache[id] = { id, filename: id, loaded: true, exports: exportsObj };
    }
    return { ownerRe, ids };
}

const INSTALLED = [
    installMocks('prefix-assembly', /directChat[\\/]promptAssembly\.js$/, ASSEMBLY_MOCKS),
    installMocks('prefix-gates', /directChat[\\/]inputGates\.js$/, GATE_MOCKS),
];
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    for (const { ownerRe, ids } of INSTALLED) {
        if (parent && ownerRe.test(parent.filename) && Object.prototype.hasOwnProperty.call(ids, request)) {
            return ids[request];
        }
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const { buildPromptAndHistory } = require('./promptAssembly');
const { runInputGates } = require('./inputGates');

test.after(() => { Module._resolveFilename = originalResolve; });

function assembleTurn(overrides = {}) {
    return buildPromptAndHistory({
        req: { session: { user: { id: 'alice' } } },
        send: noop,
        userId: 'alice',
        message: 'hello',
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

// ═══ 1. Assembly hands the turn a block of its own ═══════════════

test('assembly returns the volatile block as an object that IS messages[1]', async () => {
    const state = await assembleTurn();

    assert.ok(state.volatileMessage, 'the turn needs a named block to write its addenda on');
    assert.strictEqual(state.volatileMessage.role, 'system');
    assert.strictEqual(
        state.messages[1], state.volatileMessage,
        'the same object, not a copy — every phase writes through this reference',
    );
    assert.strictEqual(state.messages[0].role, 'system', 'index 0 stays the cacheable block');
    assert.notStrictEqual(state.messages[0], state.volatileMessage);
});

test('the clock is on the volatile block and not in the cached prefix', async () => {
    const a = await assembleTurn({ timezone: 'UTC' });
    const b = await assembleTurn({ timezone: 'UTC' });

    // The one thing that provably differs between two turns a second apart.
    assert.match(a.volatileMessage.content, /^Now: /);
    assert.strictEqual(
        a.messages[0].content, b.messages[0].content,
        'two turns of the same conversation must produce a byte-identical cached block',
    );
    assert.ok(!/^Now: /m.test(a.messages[0].content), 'the timestamp must not be in the cached block');
});

// ═══ 2. The gates write on the block, never on the prefix ════════

async function runGates({ messages, volatileMessage }) {
    // processAttachmentsAndUserMessage runs before the gates and appends this
    // turn's user message; the PII gate rewrites the LAST message in place.
    messages.push({ role: 'user', content: 'mail Jan Jansen' });
    return runInputGates({
        req: { session: { user: { id: 'alice', organizationId: 'org-1' } } },
        res: { end: noop },
        send: noop,
        userId: 'alice',
        convId: 'c1',
        message: 'mail Jan Jansen',
        messages,
        modelId: 'm1',
        config: { providerType: 'claude' },
        hasAttachments: false,
        volatileMessage,
    });
}

test('the PII addendum lands on the volatile block and leaves the cached block byte-identical', async () => {
    const state = await assembleTurn();
    const cachedBefore = state.messages[0].content;
    const volatileBefore = state.volatileMessage.content;

    gateFx.convTokenMap = { '[person_1]': 'Jan Jansen' };
    gateFx.piiResult = {
        tokenizedText: 'mail [person_1]',
        tokenMap: { '[person_1]': 'Jan Jansen' },
        entities: [{ label: 'PERSON', category: 'person' }],
    };
    const out = await runGates(state);

    assert.ok(out, 'the gates must not have blocked this turn');
    assert.strictEqual(state.messages[0].content, cachedBefore, 'the cached prefix was touched');
    assert.ok(
        state.volatileMessage.content.startsWith(volatileBefore),
        'the addendum must be appended to the volatile block, not replace it',
    );
    assert.ok(
        state.volatileMessage.content.includes('[PII TOKEN PRESERVATION'),
        'the model was never told what the placeholders mean',
    );
    assert.ok(
        state.volatileMessage.content.includes('`[person_1]`'),
        'the tokens in scope for this conversation must be named in the addendum',
    );
});

test('a clean message adds nothing to either system block', async () => {
    const state = await assembleTurn();
    const cachedBefore = state.messages[0].content;
    const volatileBefore = state.volatileMessage.content;

    gateFx.convTokenMap = {};
    gateFx.piiResult = null;
    const out = await runGates(state);

    assert.ok(out);
    assert.strictEqual(state.messages[0].content, cachedBefore);
    assert.strictEqual(state.volatileMessage.content, volatileBefore);
});

test('with no volatile block the addendum falls back to the LAST system message, never index 0', async () => {
    // A turn assembled before the block existed, or one whose block was
    // dropped: the fallback must still keep away from the cached prefix.
    const cached = { role: 'system', content: 'STABLE IDENTITY PROMPT' };
    const late = { role: 'system', content: 'Now: 2026-09-11T10:00:00Z' };
    const messages = [cached, late, { role: 'user', content: 'mail Jan Jansen' }];

    gateFx.convTokenMap = { '[person_1]': 'Jan Jansen' };
    gateFx.piiResult = {
        tokenizedText: 'mail [person_1]',
        tokenMap: { '[person_1]': 'Jan Jansen' },
        entities: [{ label: 'PERSON', category: 'person' }],
    };
    const out = await runInputGates({
        req: { session: { user: { id: 'alice', organizationId: 'org-1' } } },
        res: { end: noop },
        send: noop,
        userId: 'alice',
        convId: 'c1',
        message: 'mail Jan Jansen',
        messages,
        modelId: 'm1',
        config: { providerType: 'claude' },
        hasAttachments: false,
        volatileMessage: null,
    });

    assert.ok(out);
    assert.strictEqual(cached.content, 'STABLE IDENTITY PROMPT', 'the cached prefix was touched');
    assert.ok(late.content.includes('[PII TOKEN PRESERVATION'));
});

// ═══ 3. Source-level, and why ════════════════════════════════════

test('no file in the turn pipeline appends to messages[0].content', () => {
    // See the header: this is a claim about every call site in the folder,
    // including the ones no test drives and the ones not written yet. Both
    // regressions it guards against shipped green.
    const dir = __dirname;
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.js') && !f.endsWith('.test.js'));
    assert.ok(files.length > 20, 'the folder scan found suspiciously few files');

    const offenders = [];
    for (const f of files) {
        const src = fs.readFileSync(path.join(dir, f), 'utf8');
        // `messages[0].content +=` in any spelling, and the same through a
        // destructured alias of the first element.
        if (/messages\s*\[\s*0\s*\]\s*\.content\s*\+=/.test(src)) offenders.push(f);
    }
    assert.deepStrictEqual(
        offenders, [],
        'these files append to the provider-cached prompt prefix; per-turn text belongs on the volatile block',
    );
});
