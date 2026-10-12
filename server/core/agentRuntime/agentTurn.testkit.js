/**
 * Test kit: a real chatWithAgentStream turn without Postgres.
 *
 * Shared by toolRoundExecutor.confirm.test.js, toolRoundExecutor.kbScanning.test.js
 * and testChat.runtime.test.js. The real chatWithAgentStream is driven by a
 * scripted fake provider adapter (`S.drive`), `ephemeral: true`, and the
 * stores/heavy collaborators are swapped through testUtils/stubRequire. Keys
 * are the require strings exactly as the modules write them (a non-matching
 * key silently loads the real module, see server/ARCHITECTURE.md).
 *
 * Usage:
 *   const S = { ...turnState(), extraField: 0 };
 *   const kit = installAgentTurnHarness(S, { toolRegistry, stubs: {...} });
 *   test.after(() => kit.restore());
 *   // in the test file's reset(): resetTurnState(S, cfg)
 *
 * `stubs` overrides the defaults per require string: for a key that has a
 * default the given object is merged over it (shallow), a new key is added.
 */

const { installResolveStub } = require('../../testUtils/stubRequire');

const noop = () => {};

const fn = (name) => ({
    type: 'function',
    function: { name, description: name, parameters: { type: 'object', properties: {} } },
});

const AGENT_BASE = {
    id: 'agent-1', name: 'Test Agent', model: 'claude-x', organization_id: null,
    owner_id: 'u1', embed_enabled: false,
};

/** The mutable per-test fields every user of the kit reads. */
const turnState = () => ({
    round: 0,
    drive: null,
    tools: [],
    agentConfig: {},
    dispatched: [],
    events: [],
    toolsOfferedPerRound: [],
    toolResults: {},
    shield: null,
});

/** The owner's lent Google connection, as connectionResolution would resolve it. */
const LEND = {
    on: false,
    override: {
        integrationUserId: 'owner-2', integrationOrgId: 'org-2',
        connectionId: 'conn-1', connectionLabel: 'Owner Google', grantId: 'g-1', provider: 'google',
    },
};

/** Reset the common fields. `cfg`: drive, tools, config, toolResults. */
function resetTurnState(S, cfg = {}, defaultTools = []) {
    LEND.on = false;
    S.round = 0;
    S.drive = cfg.drive || (() => {});
    S.tools = cfg.tools || defaultTools;
    // `disableExternalTools` keeps getIntegrationTools out of the assembly, so
    // the stack is exactly what getAgentTools returns and the assertions can
    // count it.
    S.agentConfig = { disableExternalTools: true, ...(cfg.config || {}) };
    S.dispatched = [];
    S.events = [];
    S.toolsOfferedPerRound = [];
    S.toolResults = cfg.toolResults || {};
}

// The app index toolPolicy builds its grants from. Real names, so the real
// sideEffectMap is what classifies them: search reads, compose sends.
const GMAIL_TOOL_REGISTRY = {
    TOOL_REGISTRY: [{ app: 'gmail', label: 'Gmail' }],
    INLINE_TOOL_APPS: [],
    // `ALL_TOOL_APPS` is de lijst die de attributie-index leest — registry
    // PLUS de apps die hun tools inline injecteren. Zie automation/toolRegistry.js.
    ALL_TOOL_APPS: [{ app: 'gmail', label: 'Gmail' }],
    loadTools: () => [
        { function: { name: 'gmail_search' } },
        { function: { name: 'gmail_compose' } },
    ],
    loadToolsResult: () => ({
        tools: [
            { function: { name: 'gmail_search' } },
            { function: { name: 'gmail_compose' } },
        ],
        ok: true,
        reason: null,
    }),
};

/** The two tools GMAIL_TOOL_REGISTRY knows: search reads, compose sends. */
const GMAIL_TOOLS = [fn('gmail_search'), fn('gmail_compose')];

const EMPTY_TOOL_REGISTRY = {
    TOOL_REGISTRY: [], INLINE_TOOL_APPS: [], ALL_TOOL_APPS: [],
    loadTools: () => [], loadToolsResult: () => ({ tools: [], ok: true, reason: null }),
};

// chatStream became a FOLDER (chatStream/index.js + the turn's phases), so the
// modules under test now write every require one '../' deeper than they used
// to. installResolveStub matches the request string exactly as the module
// writes it, so each stub is registered at BOTH depths: the shallow key still
// covers the agentRuntime modules that did not move, the deeper one covers the
// ones that did. Missing a key here fails SILENTLY — the real module loads and
// the turn dies on a live Postgres connect somewhere unrelated.
const atBothDepths = (map) => {
    const out = { ...map };
    for (const [request, exportsObj] of Object.entries(map)) {
        const deeper = request.startsWith('./') ? '../' + request.slice(2)
            : request.startsWith('../') ? '../' + request
                : null;
        if (deeper && !(deeper in out)) out[deeper] = exportsObj;
    }
    return out;
};

function defaultStubs(S, toolRegistry) {
    // Connection lending: off unless a test turns it on, exactly like the
    // product default (INTEGRATION_CONNECTION_LENDING_ENABLED).
    const connectionResolution = {
        isLendingEnabled: () => LEND.on,
        providerForTool: () => 'google',
        runningUserContext: async () => ({ orgId: null, groups: [] }),
        resolveEffectiveIdentity: async () => (LEND.on ? LEND.override : null),
    };
    const adapter = {
        stream: async (apiKey, url, model, messages, options, cb) => {
            S.toolsOfferedPerRound.push((options?.tools || []).map(t => t.function?.name));
            await S.drive(cb, options, S.round++, messages);
        },
    };
    return {
        '../../automation/toolRegistry': toolRegistry,
        // `installResolveStub` keys on the require string as WRITTEN INSIDE the
        // asking module, and toolPolicy is a folder now: its attribution index
        // (toolPolicy/appIndex.js) sits one level deeper and asks for this string
        // for the very same module. Without it the stub stops matching and the
        // REAL registry answers — silently, which is the failure mode
        // server/ARCHITECTURE.md warns about.
        '../../../automation/toolRegistry': toolRegistry,
        '../aiAgent': {
            getAIConfig: async () => ({}),
            getProviderForModel: async () => ({
                url: 'http://provider.invalid', apiKey: 'k',
                providerType: 'claude', providerName: 'claude',
            }),
            resolveModelId: async (m) => m,
        },
        '../providers': { getAdapter: () => adapter },
        '../cms/componentManager': {},
        '../executionEngine': {},
        '../../stores/agentStore': {
            getAgent: async () => ({ ...AGENT_BASE, config: S.agentConfig }),
            getForRuntime: async () => ({ ...AGENT_BASE, config: S.agentConfig }),
            getAgentToolsWithParams: async () => [],
            getConversationMeta: async () => ({}),
            updateConversation: async () => {},
            getConversationById: async () => null,
            getOrCreateConversation: async () => ({ id: 'c1', messages: [] }),
            createNewConversation: async () => ({ id: 'c1', messages: [] }),
        },
        '../../stores/usageStore': { logUsage: async () => {} },
        '../../stores/terminationStore': { logTermination: async () => {} },
        '../../stores/guardrailEventStore': {
            logGuardrailEvent: async () => {},
            logAttachmentPiiFindings: async () => {},
            logAttachmentScanIncomplete: async () => {},
        },
        '../../stores/configStore': { getConfig: async () => null },
        // Production narrows the belt to the TICKED actions long before the model
        // sees it — integrationTools' addTools runs every candidate past
        // toolPolicy.isToolAllowed — so the stub applies the same filter. Handing
        // back the whole belt regardless of the grants would let a test about the
        // NAME WHITELIST pass on the confirmation hold instead: the unticked send
        // would still be offered, gate 2 would hold it, and gate 1 could be
        // deleted without one assertion here turning red. The grants come from
        // the config the runtime LOADED last (`S.loadedConfig`) when a test
        // tracks that, else from `S.agentConfig`.
        './agentTools': {
            getAgentTools: async () => {
                const policy = require('./toolPolicy');
                const grants = policy.toolsConfigOf(S.loadedConfig || S.agentConfig);
                return grants ? S.tools.filter(t => policy.isToolAllowed(t, grants)) : S.tools;
            },
        },
        './modelResolver': { resolveAgentModel: async () => 'claude-x' },
        './contextBuilder': { buildSystemPrompt: async () => ({ systemPrompt: 'SYS', volatileSystemPrompt: '' }) },
        './knowledgeSearch': { performKnowledgeSearch: async () => ({}), quickKBSearch: async () => [] },
        './guardrailsRunner': { runInputGuardrails: async ({ userMessage }) => ({ processedUserMessage: userMessage }) },
        './attachmentProcessor': { processAttachments: async () => ({}) },
        './historyHydrator': { hydrateHistoryAttachments: async (m) => m },
        '../llm/compaction': {
            compactMessages: (m) => ({ messages: m, newSummary: null, didSummarize: false }),
            needsSummarization: () => false,
        },
        '../../telemetry/metrics': { recordAgentRun: noop },
        '../llm/promptClassifier': { classifyPromptComplexity: () => ({}) },
        '../documents/ocr': { mistralOCR: async () => '' },
        '../privacy/orgShield': {
            resolveShieldFor: async () => S.shield,
            mergeWithOrgShield: (a) => a,
            classifyToolClass: () => 'internal',
            isBlockedForTool: () => ({ blocked: false, blockedCategories: [], toolClass: 'internal' }),
        },
        // Records every call that actually reached dispatch — the whole point of
        // the two gates is which of these entries never appear.
        '../tools/toolDispatcher': {
            executeTool: async (name, args, ctx) => {
                // `userId`/`lentConnection` are how a borrowed connection shows up
                // at dispatch — the actAs tests read them.
                S.dispatched.push({ name, args, userId: ctx?.userId, lent: !!ctx?.lentConnection, confirmLayer: ctx?.confirmLayer === true });
                return S.toolResults[name] || { ok: true, message: `${name} ran` };
            },
        },
        '../integrations/connectionResolution': connectionResolution,
        // Same one-level-deeper alias, for toolPolicy/connectionLending.js.
        '../../integrations/connectionResolution': connectionResolution,
        '../integrations/integrationLogging': { logToolEgress: noop },
        '../llm/promptUtils': { processSystemPrompt: async (s) => s },
        '../llm/promptCacheStability': { toolSetFingerprint: () => 'tf', systemPrefixFingerprint: () => 'sf' },
        '../privacy/guardrails': { checkRegexPatterns: () => [] },
        '../dlp/dlpRunner': {
            getConversationTokenMap: () => ({}),
            getConversationTokenMapAsync: async () => ({}),
            mergeTokenMap: () => {},
        },
    };
}

/**
 * Install the stubs and load chatStream.
 * @param {object} S  the file's state (see turnState)
 * @param {{ toolRegistry?: object, stubs?: object }} [opts]
 */
function installAgentTurnHarness(S, { toolRegistry = EMPTY_TOOL_REGISTRY, stubs = {} } = {}) {
    const map = defaultStubs(S, toolRegistry);
    for (const [key, over] of Object.entries(stubs)) {
        map[key] = key in map && map[key] && typeof map[key] === 'object' ? { ...map[key], ...over } : over;
    }
    const restore = installResolveStub(atBothDepths(map));
    const { chatWithAgentStream } = require('./chatStream');

    async function runTurn(meta = {}) {
        const onEvent = (type, data) => S.events.push([type, data]);
        let result = null, error = null;
        try {
            result = await chatWithAgentStream(
                'agent-1', 'u1', 'hi',
                { userId: 'u1', encryptionKey: null, session: {} },
                onEvent, null,
                { ephemeral: true, ...meta },
            );
        } catch (e) { error = e; }
        return { result, error, events: S.events };
    }

    const eventsOfType = (type) => S.events.filter(([t]) => t === type).map(([, d]) => d);
    return { restore, runTurn, eventsOfType, chatWithAgentStream };
}

module.exports = {
    installAgentTurnHarness, turnState, resetTurnState, LEND, fn, noop,
    GMAIL_TOOL_REGISTRY, GMAIL_TOOLS, EMPTY_TOOL_REGISTRY, AGENT_BASE,
};
