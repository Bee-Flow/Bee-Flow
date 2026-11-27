// @typecheck
/**
 * The harness of the tool-round gate-order tests (./toolRoundExecutor.gateOrder.test.js and the Cowork module's
 * ./toolRoundExecutor.gateOrder.cowork.test.js): every collaborator of `executeToolRound` replaced by a recorder that
 * writes the ordered trace `T`, the per-test knobs `S` (see `reset`), and `round`, which drives one round.
 *
 * The stubs are preloaded under the REAL resolved path of each module, so they hold whichever file of the round asks
 * for them. Requiring this kit installs them; require it before anything that loads the round.
 */

const { preloadStubs } = require('../../testUtils/stubRequire');

const REAL_EMAIL = 'jan@example.test';
const TOKEN = '[email_1]';

// ── Recorders ────────────────────────────────────────────────────────
const T = [];                  // the ordered trace
const S = {};                  // per-test knobs, see reset()

function reset(knobs = {}) {
    T.length = 0;
    Object.assign(S, {
        verdicts: {},          // toolName -> decideToolCall verdict
        tokenMap: { [TOKEN]: REAL_EMAIL },
        regexIn: false,        // checkRegexPatterns hits on tool input
        regexOut: false,       // ... on tool output
        argPii: null,          // (text, cats) -> detectPii answer for ARGUMENTS
        resultPii: null,       // (text, cats) -> detectPii answer for RESULTS
        results: {},           // toolName -> dispatch result (Error -> throws)
        lend: false,
        classOf: {},
        dispatchCtx: [],
        egress: [],
        guardrail: [],
        usage: [],
    }, knobs);
}
reset();

preloadStubs(require, {
    './toolPolicy': {
        decideToolCall: ({ toolName, policy }) => {
            T.push(`gate1:${toolName}`);
            return S.verdicts[toolName] || { action: 'run', reason: null, effect: 'reads', policy };
        },
        previewToolArgs: (a) => ({ ...a }),
        mayLendOwnerConnection: (name) => { T.push(`mayLend:${name}`); return true; },
    },
    '../dlp/dlpRunner': {
        getConversationTokenMap: () => { T.push('tokenMap'); return S.tokenMap; },
        mergeTokenMap: (id, map) => { T.push(`mergeTokenMap:${Object.keys(map).join(',')}`); },
    },
    '../dlp/applyTokenMapToOutbound': {
        untokeniseToolArgs: (args, map) => {
            T.push('untokenise');
            let s = JSON.stringify(args);
            for (const [tok, real] of Object.entries(map)) s = s.split(tok).join(real);
            return JSON.parse(s);
        },
    },
    '../privacy/guardrails': {
        checkRegexPatterns: () => {
            const isOutput = T.some(t => t.startsWith('dispatch:'));
            T.push(isOutput ? 'regex:out' : 'regex:in');
            const hit = isOutput ? S.regexOut : S.regexIn;
            return hit ? [{ ruleName: 'NoSecrets' }] : [];
        },
    },
    '../privacy/piiDetection': {
        detectPii: async (text, cats) => {
            // The result pre-scan asks for scanCategoriesFor(...) (stubbed
            // below as `all-<class>`); the argument scan for the block list.
            const phase = Array.isArray(cats) && cats.some(c => String(c).startsWith('all-')) ? 'result' : 'args';
            T.push(`detect:${phase}:${Array.isArray(cats) ? cats.join('+') : cats}`);
            const fn = phase === 'args' ? S.argPii : S.resultPii;
            if (fn) return fn(String(text), cats);
            return { hasPii: false, entities: [] };
        },
        restoreTokens: (content) => content,
    },
    '../privacy/orgShield': {
        classifyToolClass: (name) => S.classOf[name] || 'internal',
    },
    '../privacy/customTypes/plan': {
        scanCategoriesFor: (shield, cls) => [`all-${cls}`],
    },
    '../dlp/toolResultRedact': {
        redactAndTokenizeToolResult: (scanStr, entities, blockCats) => {
            T.push('redact');
            let content = scanStr;
            let blockedCount = 0;
            const tokenMap = {};
            for (const e of entities) {
                if (blockCats.has(e.category)) { blockedCount += 1; content = content.split(e.text).join('[redacted]'); }
                else { tokenMap[TOKEN] = e.text; content = content.split(e.text).join(TOKEN); }
            }
            return { content, tokenMap, blockedCount, redactedLabels: ['Email Address'], redactedLogLabels: ['Email'] };
        },
    },
    '../tools/toolDispatcher': {
        executeTool: async (name, args, ctx) => {
            T.push(`dispatch:${name}`);
            S.dispatchCtx.push({ name, args, ctx });
            const r = S.results[name];
            if (r instanceof Error) throw r;
            return r === undefined ? { ok: true, message: `${name} ran` } : r;
        },
    },
    '../integrations/connectionResolution': {
        isLendingEnabled: () => { T.push('lendingEnabled'); return S.lend; },
        runningUserContext: async () => ({ orgId: 'org-1', groups: [] }),
        resolveEffectiveIdentity: async () => (S.lend
            ? { integrationUserId: 'owner-2', integrationOrgId: 'org-2', connectionId: 'conn-1', grantId: 'g-1' }
            : null),
    },
    '../integrations/integrationLogging': {
        logToolEgress: (o) => {
            T.push(`egress:${o.toolName}:${o.error ? 'error' : 'ok'}`);
            S.egress.push(o);
        },
    },
    '../../stores/usageStore': {
        logUsage: async (row) => { T.push(`usage:${row.tool_name}`); S.usage.push(row); },
    },
    '../../stores/guardrailEventStore': {
        logGuardrailEvent: async (row) => { T.push(`guardrail:${row.action_taken}`); S.guardrail.push(row); },
    },
});

const exec = require('./toolRoundExecutor');
const { executeToolRound } = exec;

// ── One round ────────────────────────────────────────────────────────
const call = (id, name, args) => ({ id, function: { name, arguments: typeof args === 'string' ? args : JSON.stringify(args) } });

async function round(currentToolCalls, over = {}) {
    const events = [];
    const ctx = {
        currentToolCalls,
        toolCalls: [],
        signal: null,
        onEvent: (type, data) => { T.push(`event:${type}${data?.name ? ':' + data.name : ''}`); events.push([type, data]); },
        messages: [],
        durableMessages: [],
        persistDurable: async () => { T.push('persist'); },
        dlpShield: null,
        regexConfig: null,
        webSearchGuardEnabled: false,
        webSearchGuardPiiCategories: null,
        toolParamsMap: {},
        userAuth: { session: { sid: 's' } },
        userId: 'u1',
        agent: { id: 'agent-1', name: 'A', organization_id: 'org-1', owner_id: 'u9', config: {} },
        agentId: 'agent-1',
        conversation: { id: 'c1' },
        modelToUse: 'model-x',
        messageMetadata: {},
        onSkillsActivated: null,
        toolPolicy: { marker: 'policy' },
        _failingToolCounts: new Map(),
        MAX_TOOL_REPEAT: 3,
        _toolHistory: [],
        _emailDrafts: [],
        _calendarDrafts: [],
        _linkedInDrafts: [],
        _mapEmbeds: [],
        _audioFiles: [],
        _generatedFiles: [],
        _kbSources: [],
        _seenChunkIds: new Set(),
        _pendingToolCalls: [],
        _pendingToolCounts: new Map(),
        ...over,
    };
    const bail = await executeToolRound(ctx);
    return { bail, events, ctx, trace: [...T] };
}

const SHIELD = (extra = {}) => ({
    enabled: true, privacyAction: 'redact', piiDetectionConfidenceThreshold: 0.7,
    toolPiiPolicy: { external: { blockCategories: [] }, internal: { blockCategories: [] } },
    ...extra,
});
const REGEX = { enabled: true, scope: { toolInput: true, toolOutput: true }, rulesWithNames: [] };

module.exports = { REAL_EMAIL, TOKEN, T, S, reset, exec, executeToolRound, call, round, SHIELD, REGEX };
