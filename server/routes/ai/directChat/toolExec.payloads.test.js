/**
 * Characterisation of the payloads executeDirectChatToolCall builds: the full
 * option object handed to the dispatcher, the guardrail audit rows (regex,
 * PII block, PII monitor, tool block list), the usage row and the egress
 * log arguments. Pinned before the builders moved to toolExecPayloads.js.
 */

const test = require('node:test');
const assert = require('node:assert');
const { installResolveStub } = require('../../../testUtils/stubRequire');

const h = { dispatch: [], guard: [], usage: [], egress: [], pii: { hasPii: true, entities: [{ label: 'Email' }] } };

const restore = installResolveStub({
    '../../../core/privacy/guardrails': { checkRegexPatterns: (q) => (/BLOCKME/.test(q) ? [{ ruleName: 'r1' }, { ruleName: 'r2' }] : []) },
    '../../../core/tools/toolDisclosure': { LOAD_TOOLS_TOOL_NAME: 'load_tools' },
    '../../../core/tools/sessionSkillRuntime': { ACTIVATE_SESSION_SKILL_TOOL_NAME: 'a', COMPLETE_SESSION_SKILL_TOOL_NAME: 'c' },
    '../../../core/tools/toolDispatcher': { executeTool: async (name, args, opts) => { h.dispatch.push({ name, args, opts }); return { ok: 1 }; } },
    '../../../core/http/outboundProbe': { runWithProbe: async (fn) => ({ result: await fn(), probe: { probed: true } }), markLocal: () => {} },
    '../../../core/integrations/integrationToolMap': { resolveIntegration: () => null },
    '../../../integrations/webpageBuilderTools': { isBuilderTool: () => false, executeBuilderTool: async () => ({ result: {} }) },
    '../../../integrations/documentBuilderTools': { isDocumentTool: () => false, executeDocumentTool: async () => ({}) },
    '../../../integrations/webpageDbTools': { isDbTool: () => false, executeDbTool: async () => ({}) },
    '../../../integrations/webpagePlanTool': { executeProposeWebpagePlan: () => ({}) },
    '../../../core/dlp/applyTokenMapToOutbound': { untokeniseToolArgs: (a) => a },
    '../../../stores/guardrailEventStore': { logGuardrailEvent: (row) => { h.guard.push(row); return Promise.resolve(); } },
    '../../../stores/configStore': { getConfig: async () => null },
    '../../../core/dlp/dlpRunner': { getConversationTokenMap: () => ({}) },
    '../../../core/privacy/piiDetection': { detectPii: async () => h.pii, restoreTokens: (t) => t },
    '../../../stores/usageStore': { logUsage: async (row) => { h.usage.push(row); } },
    '../../../core/integrations/integrationLogging': { logToolEgress: (a) => h.egress.push(a) },
    '../../stores/configStore': { getConfig: async () => null, setConfig: async () => true, getAllConfig: async () => ({}) },
});
test.after(() => restore());
test.beforeEach(() => { h.dispatch = []; h.guard = []; h.usage = []; h.egress = []; });

const { executeDirectChatToolCall } = require('./toolExec');

function mkCtx(over = {}) {
    const events = [];
    const ctx = {
        streamed: true, userAuth: { token: 'ua' }, convId: 'conv-1', resolvedTier: 'fast', userOrgId: 'org-1', userId: 'user-1',
        n8nOrgId: 'org-n8n', req: { session: { user: { id: 'user-1' } } }, regexConfig: null, webSearchGuardPiiCategories: null,
        webSearchGuardEnabled: false, imageGenSettings: { ig: 1 }, nanoBananaSettings: { nb: 1 }, attachments: [{ a: 1 }],
        sessionSkills: [{ id: 's1' }], webpageBuilderReadSlots: { s: 1 }, collectedToolHistory: [],
        getModelId: () => 'model-1', getActivatedSessionSkillIds: () => ['x'], getCompletedSessionSkillIds: () => ['y'],
        getRoundsInCurrentStep: () => 4, onImageGenerated: () => {}, onSkillsActivated: () => {},
        send: (t, d) => events.push([t, d]), getTierToolParams: async () => ({ fast: { my_tool: { fixed: true } } }),
        ...over,
    };
    return { ctx, events };
}
const call = (name, args) => ({ id: 'tc-1', function: { name, arguments: JSON.stringify(args) } });

test('dispatcher options: the full surface, timezone default, tier overrides', async () => {
    const { ctx, events } = mkCtx();
    await executeDirectChatToolCall(call('my_tool', { a: 1 }), ctx);
    const { opts } = h.dispatch[0];
    assert.deepStrictEqual(Object.keys(opts), [
        'userId', 'session', 'userAuth', 'fixedParams', 'agentId', 'conversationId', 'orgId', 'send', 'imageGenSettings',
        'nanoBananaSettings', 'req', 'attachments', 'sessionSkills', 'activatedSessionSkillIds', 'completedSessionSkillIds',
        'roundsInCurrentStep', 'timezone', 'onImageGenerated', 'onSkillsActivated', 'terminalCtx',
    ]);
    const { send, onImageGenerated, onSkillsActivated, terminalCtx, ...plain } = opts;
    assert.deepStrictEqual(plain, {
        userId: 'user-1', session: ctx.req.session, userAuth: { token: 'ua' }, fixedParams: { fixed: true }, agentId: null,
        conversationId: 'conv-1', orgId: 'org-n8n', imageGenSettings: { ig: 1 }, nanoBananaSettings: { nb: 1 }, req: ctx.req,
        attachments: [{ a: 1 }], sessionSkills: [{ id: 's1' }], activatedSessionSkillIds: ['x'], completedSessionSkillIds: ['y'],
        roundsInCurrentStep: 4, timezone: 'Europe/Amsterdam',
    });
    assert.strictEqual(send, ctx.send);
    assert.strictEqual(onImageGenerated, ctx.onImageGenerated);
    assert.strictEqual(onSkillsActivated, ctx.onSkillsActivated);
    const { onEvent, ...term } = terminalCtx;
    assert.deepStrictEqual(term, { agentId: 'user-user-1', containerKey: 'direct-conv-1', timeout: 60000, blockedCommands: [], signal: undefined });
    onEvent('t', { d: 1 });
    assert.deepStrictEqual(events.at(-1), ['t', { d: 1 }]);
});

test('usage row + egress payload', async () => {
    const { ctx } = mkCtx();
    await executeDirectChatToolCall(call('my_tool', { a: 1 }), ctx);
    assert.deepStrictEqual(h.usage, [{
        user_id: 'user-1', agent_name: 'direct-chat', agent_type: 'chat', model: 'model-1', tool_name: 'my_tool',
        source: 'direct_chat', organization_id: 'org-1', conversation_id: 'conv-1',
    }]);
    const { durationMs, ...egress } = h.egress[0];
    assert.strictEqual(typeof durationMs, 'number');
    assert.deepStrictEqual(egress, {
        toolName: 'my_tool', toolArgs: { a: 1 }, result: { ok: 1 }, error: null, probe: { probed: true }, source: 'direct_chat',
        model: 'model-1', session: ctx.req.session, ids: { organization_id: 'org-1', user_id: 'user-1', conversation_id: 'conv-1' },
    });
});

test('guardrail rows: regex, PII block, PII monitor; read_url guard text', async () => {
    const base = { organization_id: 'org-1', user_id: 'user-1', conversation_id: 'conv-1', direction: 'input', source: 'direct', model: 'model-1' };
    const { ctx } = mkCtx({ regexConfig: { enabled: true, rulesWithNames: [] } });
    await executeDirectChatToolCall(call('agent_search', { query: 'BLOCKME' }), ctx);
    await executeDirectChatToolCall(call('read_url', { url: 'http://x', find: 'BLOCKME' }), ctx);
    const row = { ...base, violation_type: 'regex', violation_categories: 'r1, r2', action_taken: 'search_blocked' };
    assert.deepStrictEqual(h.guard, [row, row]);
    h.guard = [];
    const pii = mkCtx({ webSearchGuardPiiCategories: ['Email'], webSearchGuardEnabled: true });
    await executeDirectChatToolCall(call('agent_search', { query: 'q' }), pii.ctx);
    const mon = mkCtx({ webSearchGuardPiiCategories: ['Email'] });
    await executeDirectChatToolCall(call('agent_search', { query: 'q' }), mon.ctx);
    assert.deepStrictEqual(h.guard, [
        { ...base, violation_type: 'pii', violation_categories: 'Email', action_taken: 'search_blocked' },
        { ...base, violation_type: 'pii', violation_categories: 'Email', action_taken: 'pii_detected' },
    ]);
});
