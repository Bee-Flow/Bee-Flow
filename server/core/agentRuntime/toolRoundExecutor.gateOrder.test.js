/**
 * Characterisation: the ORDER of the security gates in one tool round.
 *
 * `executeToolRound` is driven directly (no chat turn around it) with every
 * collaborator replaced by a recorder, so each test reads as a trace of what
 * ran, in which order:
 *
 *   JSON parse -> gate 1 (name offered?) -> DLP restore of the arguments ->
 *   tool_start -> abort check -> regex (tool input) -> tool-PII policy on the
 *   arguments -> gate 2 (confirmation hold) -> connection lending -> dispatch
 *   -> regex (tool output) -> loop brakes -> result PII pre-scan ->
 *   in-order result loop (tool_end, side channels, usage row, egress row,
 *   result redaction, tool messages) -> persist.
 *
 * A refusal at any gate must leave every LATER step out of the trace: that is
 * what these tests pin, together with the exact text the model is shown.
 *
 * The stubs are preloaded under the REAL resolved path of each module, so
 * they hold whichever file of the round asks for them (the round lives in a
 * folder of its own; the require strings there are one level deeper).
 *
 * Synthetic data. Run: node --test core/agentRuntime/toolRoundExecutor.gateOrder.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
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

// ── The export surface ───────────────────────────────────────────────
test('the module exports exactly the same keys', () => {
    assert.deepStrictEqual(Object.keys(exec).sort(), [
        'MAX_TOOL_CONTENT_BYTES', '_flattenToolRoundTrips', '_stableStringify',
        'buildLLMToolContent', 'executeToolRound', 'truncateToolContent',
    ]);
    assert.strictEqual(exec.MAX_TOOL_CONTENT_BYTES, 128 * 1024);
});

// ── The happy path, every gate armed ─────────────────────────────────
test('a clean call walks every gate in order, then dispatch, then the result loop', async () => {
    reset({
        results: { web_lookup: { hits: [`mail ${REAL_EMAIL}`], _action: 'none' } },
        resultPii: (text) => {
            const offset = text.indexOf(REAL_EMAIL);
            return offset < 0 ? { hasPii: false, entities: [] }
                : { hasPii: true, entities: [{ text: REAL_EMAIL, category: 'Email', label: 'Email Address', offset, length: REAL_EMAIL.length }] };
        },
        classOf: { web_lookup: 'external' },
    });
    const { bail, ctx, trace } = await round([call('c-1', 'web_lookup', { q: `write to ${TOKEN}` })], {
        dlpShield: SHIELD({ toolPiiPolicy: { external: { blockCategories: ['Phone'] } } }),
        regexConfig: REGEX,
    });
    assert.strictEqual(bail, null);
    assert.deepStrictEqual(trace, [
        'gate1:web_lookup',
        'tokenMap', 'untokenise',              // DLP restore AFTER gate 1
        'event:tool_start:web_lookup',
        'regex:in',
        'detect:args:Phone',                   // tool-PII policy on the restored args
        'mayLend:web_lookup', 'lendingEnabled', // gate 2 passed silently -> lending
        'dispatch:web_lookup',
        'regex:out',
        'detect:result:all-external',          // concurrent pre-scan
        'event:tool_end:web_lookup',
        'usage:web_lookup',
        'egress:web_lookup:ok',
        'tokenMap', 'redact', 'mergeTokenMap:[email_1]',
        'persist',
    ]);
    // The tool received the REAL value, the model sees the token.
    assert.deepStrictEqual(S.dispatchCtx[0].args, { q: `write to ${REAL_EMAIL}` });
    assert.strictEqual(ctx.messages.length, 1);
    assert.deepStrictEqual(ctx.messages[0], {
        role: 'tool', tool_call_id: 'c-1', content: JSON.stringify({ hits: [`mail ${TOKEN}`] }),
    });
    assert.deepStrictEqual(ctx.durableMessages, ctx.messages);
    assert.strictEqual(ctx.messages[0], ctx.durableMessages[0], 'one object in both arrays');
    assert.deepStrictEqual(ctx.toolCalls, [{
        name: 'web_lookup', args: { q: `write to ${REAL_EMAIL}` },
        result: { hits: [`mail ${REAL_EMAIL}`], _action: 'none' },
    }]);
    assert.strictEqual(ctx._toolHistory[0].status, 'done');
    // Dispatch context: the fields the dispatcher and its tools read.
    const dctx = S.dispatchCtx[0].ctx;
    assert.strictEqual(dctx.userId, 'u1');
    assert.strictEqual(dctx.askerUserId, 'u1');
    assert.strictEqual(dctx.confirmLayer, true);
    assert.strictEqual(dctx.unattended, false);
    assert.strictEqual(dctx.autoSend, false);
    assert.strictEqual(dctx.orgId, 'org-1');
    assert.strictEqual(dctx.conversationId, 'c1');
    assert.strictEqual(dctx.agentId, 'agent-1');
    assert.strictEqual(dctx.testAs, null);
    // Egress row: success, with the dispatch duration carried across scopes.
    assert.strictEqual(typeof S.egress[0].durationMs, 'number');
    assert.strictEqual(S.egress[0].ids.acting_user_id, null);
    assert.strictEqual(S.egress[0].source, 'agent_stream');
    assert.strictEqual(S.usage[0].source, 'agent_chat');
});

test('no shield, no regex: only the gates that are always on run', async () => {
    reset();
    const { bail, trace, ctx } = await round([call('c-1', 'kb_lookup', { q: 'x' })]);
    assert.strictEqual(bail, null);
    assert.deepStrictEqual(trace, [
        'gate1:kb_lookup', 'tokenMap', 'untokenise', 'event:tool_start:kb_lookup',
        'mayLend:kb_lookup', 'lendingEnabled', 'dispatch:kb_lookup',
        'event:tool_end:kb_lookup', 'usage:kb_lookup', 'egress:kb_lookup:ok', 'persist',
    ]);
    assert.strictEqual(ctx.messages[0].content, JSON.stringify({ ok: true, message: 'kb_lookup ran' }));
});

// ── Refusals: everything after the refusing gate stays out ───────────
test('invalid JSON is refused before gate 1: nothing else runs', async () => {
    reset();
    const { trace, ctx, bail } = await round([call('c-1', 'web_lookup', '{not json')]);
    assert.strictEqual(bail, null);
    assert.deepStrictEqual(trace, ['event:tool_end:web_lookup', 'usage:web_lookup', 'persist']);
    assert.match(ctx.messages[0].content, /^\[Tool 'web_lookup' arguments were not valid JSON: .+\. Please re-emit the tool call with well-formed JSON\.\]$/);
});

test('gate 1 refuses an unoffered name BEFORE the DLP restore and before any dispatch or egress', async () => {
    reset({ verdicts: { send_all: { action: 'refuse', reason: 'not_offered', effect: 'sends' } } });
    const { trace, ctx } = await round([call('c-1', 'send_all', { to: TOKEN })], { dlpShield: SHIELD(), regexConfig: REGEX });
    assert.deepStrictEqual(trace, [
        'gate1:send_all',
        'event:tool_start:send_all',
        'detect:result:all-internal',
        'event:tool_end:send_all',
        'usage:send_all',
        'persist',
    ]);
    assert.strictEqual(ctx.messages[0].content,
        "[Tool 'send_all' is not available to this agent and was not called. Use only the tools you were given.]");
    // The arguments shown on tool_start are still the TOKENISED ones.
    assert.deepStrictEqual(ctx.toolCalls[0].args, { to: TOKEN });
});

test('an unenforced unoffered name goes on to the dispatcher (warning only)', async () => {
    reset({ verdicts: { legacy_tool: { action: 'run', reason: 'not_offered_unenforced', effect: 'reads' } } });
    const { trace } = await round([call('c-1', 'legacy_tool', {})]);
    assert.ok(trace.includes('dispatch:legacy_tool'));
});

test('an aborted client skips the call after tool_start, before the regex gate', async () => {
    reset();
    const ac = new AbortController(); ac.abort();
    const { trace, ctx } = await round([call('c-1', 'web_lookup', {})], { signal: ac.signal, regexConfig: REGEX });
    assert.deepStrictEqual(trace, [
        'gate1:web_lookup', 'tokenMap', 'untokenise', 'event:tool_start:web_lookup',
        'event:tool_end:web_lookup', 'usage:web_lookup', 'persist',
    ]);
    assert.strictEqual(ctx.messages[0].content, '[Tool execution skipped — client aborted]');
});

test('the regex input gate refuses before the PII policy and before the confirmation hold', async () => {
    reset({
        regexIn: true,
        verdicts: { gmail_compose: { action: 'confirm', reason: null, effect: 'sends' } },
    });
    const { trace, ctx, events } = await round([call('c-1', 'gmail_compose', { to: 'a' })], {
        regexConfig: REGEX, dlpShield: SHIELD({ toolPiiPolicy: { internal: { blockCategories: ['Email'] } } }),
    });
    assert.deepStrictEqual(trace, [
        'gate1:gmail_compose', 'tokenMap', 'untokenise', 'event:tool_start:gmail_compose',
        'regex:in',
        'event:tool_end:gmail_compose',          // the gate's own tool_end
        'detect:result:all-internal',
        'event:tool_end:gmail_compose',          // the result loop's
        'usage:gmail_compose', 'persist',
    ]);
    assert.strictEqual(ctx.messages[0].content, '[Tool input blocked - violates NoSecrets policy]');
    assert.strictEqual(events.filter(([t]) => t === 'tool_confirm').length, 0);
    assert.deepStrictEqual(ctx._pendingToolCalls, []);
});

test('blocked PII in the arguments is refused BEFORE the confirmation hold: no card for a call that cannot run', async () => {
    reset({
        verdicts: { gmail_compose: { action: 'confirm', reason: null, effect: 'sends' } },
        classOf: { gmail_compose: 'external' },
        argPii: (text) => (text.includes(REAL_EMAIL)
            ? { hasPii: true, entities: [{ text: REAL_EMAIL, category: 'Email', label: 'Email Address', offset: 0, length: 1 }] }
            : { hasPii: false, entities: [] }),
    });
    const { trace, ctx, events, bail } = await round([call('c-1', 'gmail_compose', { to: TOKEN })], {
        dlpShield: SHIELD({ toolPiiPolicy: { external: { blockCategories: ['Email'] } } }),
    });
    assert.strictEqual(bail, null);
    assert.deepStrictEqual(trace, [
        'gate1:gmail_compose', 'tokenMap', 'untokenise', 'event:tool_start:gmail_compose',
        'detect:args:Email',
        'guardrail:tool_blocked',
        'event:tool_end:gmail_compose',
        'detect:result:all-external',
        'event:tool_end:gmail_compose',
        'usage:gmail_compose', 'persist',
    ]);
    assert.strictEqual(ctx.messages[0].content,
        "[Tool 'gmail_compose' was not called: its arguments contained Email Address, which org policy forbids sending to external tools. Continue without that information or ask the user how to proceed.]");
    assert.strictEqual(events.filter(([t]) => t === 'tool_confirm').length, 0);
    assert.strictEqual(S.guardrail[0].direction, 'output');
    assert.strictEqual(S.guardrail[0].violation_categories, 'Email Address');
});

test('a degraded PII scan fails closed for a block-action org with a block list', async () => {
    reset({ argPii: () => ({ degraded: true, degradedReason: 'down', entities: [] }), classOf: { web_lookup: 'external' } });
    const { trace, ctx } = await round([call('c-1', 'web_lookup', { q: 'x' })], {
        dlpShield: SHIELD({ privacyAction: 'block', toolPiiPolicy: { external: { blockCategories: ['Email'] } } }),
    });
    assert.ok(!trace.some(t => t.startsWith('dispatch:')));
    assert.ok(!trace.some(t => t.startsWith('egress:')));
    assert.strictEqual(ctx.messages[0].content,
        "[Tool 'web_lookup' was not called: the PII guard is unavailable and org policy fails closed. Ask the user to retry shortly.]");
});

test('a degraded PII scan fails OPEN for a redact-action org', async () => {
    reset({ argPii: () => ({ degraded: true, entities: [] }), classOf: { web_lookup: 'external' } });
    const { trace } = await round([call('c-1', 'web_lookup', { q: 'x' })], {
        dlpShield: SHIELD({ toolPiiPolicy: { external: { blockCategories: ['Email'] } } }),
    });
    assert.ok(trace.includes('dispatch:web_lookup'));
});

test('the legacy web search guard: enabled blocks external tools, disabled only monitors search', async () => {
    const hit = (text) => (text.includes(REAL_EMAIL)
        ? { hasPii: true, entities: [{ text: REAL_EMAIL, category: 'Email', label: 'Email Address', offset: 0, length: 1 }] }
        : { hasPii: false, entities: [] });
    reset({ argPii: hit, classOf: { web_search: 'external' } });
    let r = await round([call('c-1', 'web_search', { q: REAL_EMAIL })], {
        webSearchGuardEnabled: true, webSearchGuardPiiCategories: ['Email'],
    });
    assert.ok(!r.trace.includes('dispatch:web_search'));
    assert.deepStrictEqual(S.guardrail.map(g => g.action_taken), ['tool_blocked']);

    reset({ argPii: hit, classOf: { web_search: 'external' } });
    r = await round([call('c-1', 'web_search', { q: REAL_EMAIL })], {
        webSearchGuardEnabled: false, webSearchGuardPiiCategories: ['Email'],
    });
    assert.ok(r.trace.includes('dispatch:web_search'));
    assert.deepStrictEqual(S.guardrail.map(g => g.action_taken), ['pii_detected']);
    assert.ok(r.trace.indexOf('guardrail:pii_detected') < r.trace.indexOf('dispatch:web_search'));
});

// ── Gate 2 ───────────────────────────────────────────────────────────
test('gate 2 holds a confirm call last: after the PII policy, with no lending, dispatch or egress', async () => {
    reset({ verdicts: { gmail_compose: { action: 'confirm', reason: null, effect: 'sends' } } });
    const { trace, ctx, events, bail } = await round([call('c-1', 'gmail_compose', { to: 'a' })], {
        dlpShield: SHIELD({ toolPiiPolicy: { internal: { blockCategories: ['Phone'] } } }),
    });
    assert.strictEqual(bail, null);
    assert.deepStrictEqual(trace, [
        'gate1:gmail_compose', 'tokenMap', 'untokenise', 'event:tool_start:gmail_compose',
        'detect:args:Phone',
        'event:tool_confirm',
        'detect:result:all-internal',
        'event:tool_end:gmail_compose', 'usage:gmail_compose', 'persist',
    ]);
    assert.strictEqual(ctx._pendingToolCalls.length, 1);
    const card = ctx._pendingToolCalls[0];
    assert.deepStrictEqual(Object.keys(card), ['callId', 'toolName', 'effect', 'preview', 'argsKey', 'status']);
    assert.strictEqual(card.status, 'pending');
    assert.strictEqual(card.callId, 'c-1');
    assert.match(card.argsKey, /^[0-9a-f]+$/);
    assert.strictEqual(events.find(([t]) => t === 'tool_confirm')[1], card);
    assert.strictEqual(ctx.messages[0].content,
        "Waiting for the user to approve 'gmail_compose'. It has not run. Tell the user what you are about to do and stop — do not call it again.");
    assert.strictEqual(ctx._failingToolCounts.size, 0, 'a held call is not a failing call');
});

test('a re-held action: one card per turn, then "still waiting", then the pending bail', async () => {
    reset({ verdicts: { gmail_compose: { action: 'confirm', reason: null, effect: 'sends' } } });
    const _pendingToolCounts = new Map();
    const _pendingToolCalls = [];
    const _failingToolCounts = new Map();
    const shared = { _pendingToolCounts, _pendingToolCalls, _failingToolCounts };
    // Two identical calls in ONE round count once.
    let r = await round([call('a', 'gmail_compose', { to: 'a' }), call('b', 'gmail_compose', { to: 'a' })], shared);
    assert.strictEqual(r.bail, null);
    assert.strictEqual(_pendingToolCalls.length, 1);
    assert.deepStrictEqual([..._pendingToolCounts.values()], [1]);
    r = await round([call('c', 'gmail_compose', { to: 'a' })], shared);
    assert.strictEqual(r.bail, null);
    assert.strictEqual(_pendingToolCalls.length, 1);
    assert.match(r.ctx.messages[0].content, /^Still waiting for the user to approve 'gmail_compose'\./);
    r = await round([call('d', 'gmail_compose', { to: 'a' })], shared);
    assert.strictEqual(r.bail, 'pending_confirmation');
    assert.ok(!r.trace.some(t => t.startsWith('dispatch:')));
});

test('a testchat holds a non-read that the policy would run, and a decision is consumed once', async () => {
    reset({ verdicts: { gmail_compose: { action: 'run', reason: null, effect: 'sends' } } });
    const messageMetadata = { testChat: true };
    let r = await round([call('a', 'gmail_compose', { to: 'a' })], { messageMetadata });
    assert.ok(!r.trace.includes('dispatch:gmail_compose'));
    const argsKey = r.ctx._pendingToolCalls[0].argsKey;

    // Approve: runs once, the approval is gone afterwards.
    reset({ verdicts: { gmail_compose: { action: 'run', reason: null, effect: 'sends' } } });
    messageMetadata.toolDecisions = [{ argsKey, decision: 'approve' }];
    r = await round([call('b', 'gmail_compose', { to: 'a' })], { messageMetadata });
    assert.deepStrictEqual(r.trace.slice(0, 6), [
        'gate1:gmail_compose', 'tokenMap', 'untokenise', 'event:tool_start:gmail_compose',
        'event:tool_confirm', 'mayLend:gmail_compose',
    ]);
    assert.ok(r.trace.includes('dispatch:gmail_compose'));
    assert.strictEqual(r.events.find(([t]) => t === 'tool_confirm')[1].status, 'approved');
    assert.strictEqual(messageMetadata.toolDecisions.size, 0);
    assert.strictEqual(S.usage[0].source, require('./testChat').TEST_CHAT_USAGE_SOURCE);
    assert.strictEqual(S.egress[0].source, require('./testChat').TEST_CHAT_USAGE_SOURCE);

    // Decline: never dispatched, the model is told.
    reset({ verdicts: { gmail_compose: { action: 'run', reason: null, effect: 'sends' } } });
    messageMetadata.toolDecisions = [{ argsKey, decision: 'decline' }];
    r = await round([call('c', 'gmail_compose', { to: 'a' })], { messageMetadata });
    assert.ok(!r.trace.includes('dispatch:gmail_compose'));
    assert.strictEqual(r.ctx.messages[0].content,
        "The user declined 'gmail_compose'. It has not run and must not be attempted again this turn. Tell the user you did not do it.");
});

// ── Dispatch, lending, egress ────────────────────────────────────────
test('a lent connection reaches dispatch and both egress rows carry its attribution', async () => {
    reset({ lend: true });
    await round([call('c-1', 'drive_search', { q: 'x' })]);
    const dctx = S.dispatchCtx[0].ctx;
    assert.strictEqual(dctx.userId, 'owner-2');
    assert.strictEqual(dctx.askerUserId, 'u1');
    assert.strictEqual(dctx.orgId, 'org-2');
    assert.ok(dctx.lentConnection);
    assert.deepStrictEqual(
        [S.egress[0].ids.acting_user_id, S.egress[0].ids.connection_id, S.egress[0].ids.grant_id],
        ['owner-2', 'conn-1', 'g-1']);
});

test('an acting identity is never overridden by lending', async () => {
    reset({ lend: true });
    const { trace } = await round([call('c-1', 'drive_search', {})], {
        userAuth: { integrationUserId: 'operator-7', session: {} },
    });
    assert.ok(trace.includes('lendingEnabled'));
    assert.strictEqual(S.dispatchCtx[0].ctx.userId, 'operator-7');
    assert.strictEqual(S.dispatchCtx[0].ctx.lentConnection, undefined);
});

test('a throwing tool writes ONE error egress row in the dispatch scope and none in the loop', async () => {
    reset({ results: { flaky: new Error('boom') } });
    const { trace, ctx } = await round([call('c-1', 'flaky', {})]);
    assert.deepStrictEqual(trace, [
        'gate1:flaky', 'tokenMap', 'untokenise', 'event:tool_start:flaky',
        'mayLend:flaky', 'lendingEnabled', 'dispatch:flaky',
        'egress:flaky:error',
        'event:tool_end:flaky', 'usage:flaky', 'persist',
    ]);
    assert.strictEqual(ctx.messages[0].content, "[Tool 'flaky' failed: boom]");
});

test('the regex output gate redacts the result the model sees', async () => {
    reset({ regexOut: true });
    const { ctx } = await round([call('c-1', 'web_lookup', {})], { regexConfig: REGEX });
    assert.strictEqual(ctx.messages[0].content, '[Tool output redacted - contains NoSecrets content]');
});

test('a repeated identical failure trips the repeated_failure bail, which wins over a pending one', async () => {
    reset({
        results: { flaky: new Error('boom') },
        verdicts: { gmail_compose: { action: 'confirm', reason: null, effect: 'sends' } },
    });
    const _failingToolCounts = new Map();
    const _pendingToolCounts = new Map();
    let last;
    for (let i = 0; i < 3; i++) {
        last = await round([call(`f${i}`, 'flaky', {}), call(`g${i}`, 'gmail_compose', { to: 'a' })],
            { _failingToolCounts, _pendingToolCounts });
    }
    assert.strictEqual(last.bail, 'repeated_failure');
    assert.deepStrictEqual([..._failingToolCounts.entries()], [['flaky|{}', 3]]);
});

// ── The result loop's side channels, in order ────────────────────────
test('results are processed in call order with their side-channel events', async () => {
    reset({
        results: {
            draft: { _action: 'email_draft', draft: { to: 'a', subject: 's', body: 'b' } },
            kb: {
                _action: 'kb_sources',
                _sources: [{ title: 'T', content: 'one' }, { title: 'T', content: 'one' }],
                results: [{ chunk_id: 'k1' }, { chunk_id: 'k1' }],
            },
            deck: { documentId: 'd1', name: 'Deck', url: '/d1', file: { name: 'deck.pptx' }, audioUrl: '/a.mp3' },
        },
    });
    const { ctx, events } = await round([
        call('1', 'draft', {}), call('2', 'kb', {}), call('3', 'create_presentation', {}),
    ], {});
    // create_presentation here got the default result: no document id, no document_update.
    assert.deepStrictEqual(ctx.messages.map(m => m.tool_call_id), ['1', '2', '3']);
    assert.deepStrictEqual(events.map(([t]) => t).filter(t => t !== 'tool_start'), [
        'tool_end', 'email_draft',
        'tool_end', 'kb_sources',
        'tool_end',
    ]);
    assert.strictEqual(ctx._emailDrafts[0].status, 'pending');
    assert.deepStrictEqual(ctx._kbSources.length, 1, 'turn-local dedup keeps one of two identical chunks');
    assert.deepStrictEqual(JSON.parse(ctx.messages[1].content), { results: [{ chunk_id: 'k1' }] });

    reset({ results: { create_presentation: { documentId: 'd1', name: 'Deck', url: '/d1', file: { name: 'deck.pptx' }, audioUrl: '/a.mp3' } } });
    const r = await round([call('3', 'create_presentation', {})]);
    assert.deepStrictEqual(r.events.map(([t]) => t), ['tool_start', 'tool_end', 'document_update', 'file']);
    assert.deepStrictEqual(r.ctx._audioFiles, [{ url: '/a.mp3', source: 'create_presentation' }]);
    assert.deepStrictEqual(r.ctx._generatedFiles, [{ name: 'deck.pptx' }]);
});

// ── Helpers that ride along on the module ────────────────────────────
test('buildLLMToolContent / truncateToolContent / _flattenToolRoundTrips keep their output', () => {
    assert.strictEqual(exec.buildLLMToolContent({ a: 1, _x: 2, instruction: 'i', resultCount: 3 }), '{"a":1}');
    assert.strictEqual(exec.buildLLMToolContent({ _action: 'workspace_update', message: 'm', content: 'c' }),
        '{"action":"notebook_updated","message":"m"}');
    assert.strictEqual(exec.buildLLMToolContent(null), 'null');
    assert.strictEqual(exec.buildLLMToolContent('s'), 's');
    const big = 'x'.repeat(exec.MAX_TOOL_CONTENT_BYTES + 1);
    assert.strictEqual(exec.truncateToolContent(big),
        'x'.repeat(exec.MAX_TOOL_CONTENT_BYTES) + `\n…[tool output truncated at ${exec.MAX_TOOL_CONTENT_BYTES} chars]`);
    assert.strictEqual(exec._stableStringify({ b: 1, a: undefined }), exec._stableStringify({ a: undefined, b: 1 }));
    assert.deepStrictEqual(exec._flattenToolRoundTrips([
        { role: 'user', content: 'q' },
        { role: 'assistant', content: 'thinking', tool_calls: [{ id: 't1', function: { name: 'kb', arguments: '{"q":1}' } }] },
        { role: 'tool', tool_call_id: 't1', content: 'r' },
    ]), [
        { role: 'user', content: 'q' },
        { role: 'assistant', content: 'thinking\n[Called tool kb with {"q":1}]' },
        { role: 'user', content: '[Result of tool kb]\nr' },
    ]);
});
