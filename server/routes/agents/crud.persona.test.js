/**
 * The structured role on the WRITE side (A1c): what `resolvePersonaWrite`
 * derives, what `verifyHandoffAutomation` refuses, and what PUT /agents/:id
 * actually hands to the store.
 *
 * The rule under test is one sentence: a persona may only ever point at a
 * automation of the AGENT'S OWNER, and every answer that is not a confirmed yes —
 * missing, inactive, someone else's, not agent-callable, a lookup that threw —
 * lands on the same no. The one that bites in practice is the org-admin case:
 * an admin may legitimately edit a colleague's agent, and attaching one of
 * THEIR OWN automations to it would mint a grant the agent's owner never made, on
 * an agent that runs under a different identity.
 *
 * crud.js's heavy top-level deps are stubbed through the Module resolve hook
 * (as in crud.tools.test.js / crud.authz.test.js); toolPolicy's registry is
 * stubbed too, so the grant the persona writes still goes through the REAL
 * `normaliseToolsConfig` on its way to the row.
 *
 * `automationToTool` is mocked with the same two refusals the real one makes
 * (no definition, or `trigger.kind !== 'agent_call'`) — the module itself pulls
 * in the automation store at load time, which no route test opens.
 *
 * Run: cd server && node --test --test-force-exit routes/agents/crud.persona.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

const noop = () => {};
const mw = () => (req, res, next) => next();

// ── Mutable per-test fixtures ───────────────────────────────────────
const fx = {
    userId: 'owner',
    agents: {},
    automations: {},
    automationThrows: false,
    updateCalls: [],
    updateResult: { ok: true, rev: 2 },
};

const CRUD_MOCKS = {
    '../../stores/agentStore': {
        getAgent: async (id) => fx.agents[id] || null,
        updateAgent: async (...args) => { fx.updateCalls.push(args); return fx.updateResult; },
        getAgentCategories: async () => [],
        setAgentTools: async () => {},
    },
    '../../core/agentRuntime': {},
    '../../core/aiAgent': { getAIConfig: noop, getProviderForModel: noop },
    '../../core/llm/modelResolver': { normalizeTierModel: (m) => m },
    '../../stores/configStore': {},
    '../../auth': {
        requirePermission: mw,
        requireActiveOrgForMutations: mw,
        OrgRoles: {}, SystemRoles: {},
        hasPermission: async () => true,
        resolveUserOrgIds: async () => new Set(['orgA']),
        canSeePublished: () => false,
        resolveUserGroups: async () => [],
        assertUserCanUseOrg: async () => {},
        validateSharedGroupsForOrg: async () => [],
    },
    '../../stores/memoryStore': {},
    '../../utils/routeHelpers': { getEffectiveUserId: () => fx.userId, getUserAuth: () => ({}) },
    '../../stores/userStore': { getUser: async () => ({ orgRole: 'org_admin' }) },
    '../../stores/usageStore': {},
    '../../core/entitlements/limits': { checkSubscriptionLimits: async () => ({}), checkResourceLimits: async () => ({}) },
    '../../core/http/sseHelpers': { setupSSE: noop, sendSSEError: noop, persistAndTitle: async () => {}, getOrCreateAgentConversation: async () => {} },
    '../../stores/skillStore': { getSkillScope: async () => null },
    '../../stores/knowledgeBases': { getKB: async () => null, isSystemKB: () => false },
    '../../stores/automationStore': {
        getAutomation: async (id) => {
            if (fx.automationThrows) throw new Error('automations table unreachable');
            return fx.automations[id] || null;
        },
    },
    '../../automation/agentCallableTools': {
        automationToTool: (a) => {
            const trigger = a && a.definition && a.definition.trigger;
            if (!trigger || trigger.kind !== 'agent_call') return null;
            return { function: { name: trigger.toolName || `automation_${a.id}` } };
        },
    },
};
const POLICY_MOCKS = {
    '../../../automation/toolRegistry': {
        TOOL_REGISTRY: [{ app: 'gmail', label: 'Gmail' }],
        loadTools: () => [{ function: { name: 'gmail_search' } }],
        loadToolsResult: () => ({ tools: [{ function: { name: 'gmail_search' } }], ok: true, reason: null }),
    },
    '../../integrations/connectionResolution': {
        isLendingEnabled: () => false,
        providerForTool: () => 'google',
    },
};

const MOCK_IDS = { crud: {}, policy: {} };
for (const [group, map] of [['crud', CRUD_MOCKS], ['policy', POLICY_MOCKS]]) {
    for (const [request, exportsObj] of Object.entries(map)) {
        const mockId = `mock:crud-persona:${group}:${request}`;
        MOCK_IDS[group][request] = mockId;
        require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
    }
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    const from = parent && parent.filename;
    if (from && /agents[\\/]crud\.js$/.test(from) && MOCK_IDS.crud[request]) return MOCK_IDS.crud[request];
    // toolPolicy is a FOLDER now: the stubbed requires live in its sibling
    // modules (appIndex.js, connectionLending.js), not in a single toolPolicy.js.
    if (from && /agentRuntime[\\/]toolPolicy[\\/][^\\/]+\.js$/.test(from) && MOCK_IDS.policy[request]) return MOCK_IDS.policy[request];
    return originalResolve.call(this, request, parent, ...rest);
};

const router = require('./crud');
const { resolvePersonaWrite, verifyHandoffAutomation } = router;
test.after(() => { Module._resolveFilename = originalResolve; });

function resetFx() {
    fx.userId = 'owner';
    fx.agents = {};
    fx.automations = {};
    fx.automationThrows = false;
    fx.updateCalls = [];
    fx.updateResult = { ok: true, rev: 2 };
}
test.beforeEach(resetFx);

const AGENT = (over = {}) => ({ id: 'a1', owner_id: 'owner', organization_id: 'orgA', config: {}, rev: 1, ...over });
const CALLABLE = (over = {}) => ({
    id: 'auto-1', userId: 'owner', isActive: true, title: 'Escalate to support',
    definition: { trigger: { kind: 'agent_call', toolName: 'escalate_to_support' } },
    ...over,
});
const HANDOFF = { who: 'You are support.', does: ['Answer questions'], unknown: { mode: 'handoff', automationId: 'auto-1' }, mode: 'fields' };

// ── verifyHandoffAutomation: every non-yes is a no ──────────────────

test('an automation of the agent owner, active and agent-callable, verifies', async () => {
    fx.automations['auto-1'] = CALLABLE();
    const v = await verifyHandoffAutomation(AGENT(), 'auto-1');
    assert.deepStrictEqual(v, { id: 'auto-1', label: 'escalate_to_support', title: 'Escalate to support' });
});

test('an automation belonging to the EDITOR rather than the agent owner is refused', async () => {
    // The org-admin case: allowed to edit this agent, not allowed to lend it
    // one of their own automations. The agent runs as its owner.
    fx.userId = 'org-admin';
    fx.automations['auto-1'] = CALLABLE({ userId: 'org-admin' });
    assert.strictEqual(await verifyHandoffAutomation(AGENT({ owner_id: 'owner' }), 'auto-1'), null);
});

test('missing, inactive and non-agent-callable automations are all refused', async () => {
    assert.strictEqual(await verifyHandoffAutomation(AGENT(), 'auto-1'), null, 'missing');
    fx.automations['auto-1'] = CALLABLE({ isActive: false });
    assert.strictEqual(await verifyHandoffAutomation(AGENT(), 'auto-1'), null, 'inactive');
    fx.automations['auto-1'] = CALLABLE({ definition: { trigger: { kind: 'schedule' } } });
    assert.strictEqual(await verifyHandoffAutomation(AGENT(), 'auto-1'), null, 'not agent-callable');
    fx.automations['auto-1'] = CALLABLE({ definition: null });
    assert.strictEqual(await verifyHandoffAutomation(AGENT(), 'auto-1'), null, 'no definition');
});

test('a lookup that THROWS is a no, not a yes', async () => {
    fx.automations['auto-1'] = CALLABLE();
    fx.automationThrows = true;
    assert.strictEqual(await verifyHandoffAutomation(AGENT(), 'auto-1'), null,
        '"I could not check" is the one answer that must never become "allowed"');
});

test('an agent without an owner verifies nothing', async () => {
    fx.automations['auto-1'] = CALLABLE();
    assert.strictEqual(await verifyHandoffAutomation(AGENT({ owner_id: null }), 'auto-1'), null);
});

// ── resolvePersonaWrite ─────────────────────────────────────────────

test('a fields persona becomes the system prompt', async () => {
    const r = await resolvePersonaWrite(AGENT(), { who: 'You are support.', does: ['Answer questions'], mode: 'fields' }, {});
    assert.match(r.systemPrompt, /^You are support\./);
    assert.match(r.systemPrompt, /What you do:\n- Answer questions/);
});

test('an empty persona hands back NULL, so the caller keeps the prompt it has', async () => {
    const r = await resolvePersonaWrite(AGENT(), { mode: 'fields' }, {});
    assert.strictEqual(r.systemPrompt, null);
});

test('"say I do not know" also switches strict knowledge on — for an agent that HAS knowledge', async () => {
    const r = await resolvePersonaWrite(
        AGENT(),
        { who: 'You are support.', unknown: { mode: 'honest' }, mode: 'fields' },
        { strictKnowledge: false, knowledge_base_ids: ['kb1'] },
    );
    assert.strictEqual(r.config.strictKnowledge, true);
});

test('…and leaves it alone on an agent with nothing to be strict about', async () => {
    // The wizard's first version is exactly this shape: fields, honest, no
    // knowledge base yet. `strictKnowledge` there is not "be honest", it is
    // "refuse everything" (contextBuilder), so it must not be a side effect of
    // creating an agent. Silently, too — see personaPrompt.applyPersonaToConfig.
    const r = await resolvePersonaWrite(
        AGENT(),
        { who: 'You are support.', unknown: { mode: 'honest' }, mode: 'fields' },
        { strictKnowledge: false, knowledge_base_ids: [] },
    );
    assert.strictEqual(r.config.strictKnowledge, false);
    assert.deepStrictEqual(r.warnings, []);
});

test('a VERIFIED hand-off writes the grant and names the real action in the prompt', async () => {
    fx.automations['auto-1'] = CALLABLE();
    const r = await resolvePersonaWrite(AGENT(), HANDOFF, { enabledIntegrations: [] });
    assert.deepStrictEqual(r.config.tools.automations, { 'auto-1': { confirm: 'ask' } });
    assert.match(r.systemPrompt, /hand it over with the "escalate_to_support" action/);
    assert.strictEqual(r.persona.unknown.automationId, 'auto-1');
});

test('an UNVERIFIED hand-off writes no grant, drops the id, and promises nothing', async () => {
    fx.automations['auto-1'] = CALLABLE({ userId: 'somebody-else' });
    const r = await resolvePersonaWrite(AGENT(), HANDOFF, { enabledIntegrations: [] });
    assert.strictEqual(r.config.tools, undefined, 'no grant for an automation we could not confirm');
    assert.strictEqual(r.persona.unknown.automationId, null, 'a stored id that resolves to nothing is a hand-off that never happens');
    assert.strictEqual(r.persona.unknown.mode, 'handoff', 'the MODE is the owner\'s choice and survives — only the unverified half is dropped');
    assert.ok(!/hand it over with/.test(r.systemPrompt));
    assert.match(r.systemPrompt, /say so plainly/);
    assert.ok(r.warnings.some(w => /auto-1/.test(w)), 'the editor is told why the automation did not stick');
});

test('a request that carries no config gets no config invented for it', async () => {
    fx.automations['auto-1'] = CALLABLE();
    const r = await resolvePersonaWrite(AGENT(), HANDOFF, undefined);
    assert.strictEqual(r.config, undefined,
        'folding onto the stored config would turn a persona-only save into a config write nobody asked for');
    assert.ok(r.warnings.some(w => /app configuration/.test(w)));
});

test('…and stays quiet when the stored config already says the same thing', async () => {
    const agent = AGENT({ config: { strictKnowledge: true } });
    const r = await resolvePersonaWrite(agent, { who: 'You are support.', unknown: { mode: 'honest' }, mode: 'fields' }, undefined);
    assert.deepStrictEqual(r.warnings, []);
});

// ── PUT /agents/:id, end to end ─────────────────────────────────────

function dispatch({ method, url, body = {} }) {
    return new Promise((resolve, reject) => {
        const request = {
            method, url, body, headers: {},
            session: { user: { id: fx.userId } },
            get(name) { return this.headers[String(name).toLowerCase()]; },
        };
        const res = {
            statusCode: 200,
            status(c) { this.statusCode = c; return this; },
            json(b) { this.body = b; resolve(this); return this; },
            send(b) { this.body = b; resolve(this); return this; },
            end() { resolve(this); return this; },
        };
        router(request, res, (err) => reject(err || new Error(`fell through router: ${method} ${url}`)));
    });
}

// updateAgent(id, name, description, systemPrompt, ownerId, model, starterPrompts,
//   avatar, threadsEnabled, copyEnabled, workspaceEnabled, config, embedEnabled,
//   organizationId, sharedGroups, categoryId, opts)
const lastUpdate = () => {
    const a = fx.updateCalls[fx.updateCalls.length - 1];
    return { systemPrompt: a[3], config: a[11], opts: a[16] };
};

test('PUT with a persona persists the GENERATED prompt, not the one the client sent', async () => {
    fx.agents.a1 = AGENT();
    const res = await dispatch({
        method: 'PUT', url: '/a1',
        body: { name: 'A', systemPrompt: 'whatever the client had', config: { enabledIntegrations: [] }, persona: { who: 'You are support.', does: ['Answer'], mode: 'fields' } },
    });
    assert.strictEqual(res.statusCode, 200);
    const { systemPrompt, opts } = lastUpdate();
    assert.match(systemPrompt, /^You are support\./);
    assert.strictEqual(opts.persona.mode, 'fields');
});

test('PUT WITHOUT a persona field leaves the column alone', async () => {
    fx.agents.a1 = AGENT();
    await dispatch({ method: 'PUT', url: '/a1', body: { name: 'A', systemPrompt: 'hand written' } });
    const { systemPrompt, opts } = lastUpdate();
    assert.strictEqual(systemPrompt, 'hand written', 'no persona, no generation');
    assert.strictEqual(opts.persona, undefined, 'undefined means preserve, all the way down to the SET list');
});

test('a persona-only PUT keeps the prompt the agent already had', async () => {
    // THE WOUND. An empty persona renders to null — that is by design, and the
    // comment on this very call says an empty persona must never be what
    // erases an agent's instructions. But the fallback landed on the REQUEST's
    // systemPrompt, and a persona-only PUT does not send one. `undefined` then
    // met `systemPrompt || ''` in the store, which writes the column
    // unconditionally: the agent lost its whole instruction and got a 200 for
    // it. The editor A2 is building sends exactly this shape.
    fx.agents.a1 = AGENT({ system_prompt: 'You are support. Never quote a price.' });
    const res = await dispatch({ method: 'PUT', url: '/a1', body: { name: 'A', persona: { mode: 'fields' } } });
    assert.strictEqual(res.statusCode, 200);
    const { systemPrompt } = lastUpdate();
    assert.strictEqual(systemPrompt, 'You are support. Never quote a price.');
});

test('an explicitly empty systemPrompt still clears it — that is a person, not an omission', async () => {
    // The other half of the same rule. "I want no instructions" must stay
    // sayable, or the fix above would make the field unclearable.
    fx.agents.a1 = AGENT({ system_prompt: 'the old instruction' });
    await dispatch({ method: 'PUT', url: '/a1', body: { name: 'A', systemPrompt: '', persona: { mode: 'fields' } } });
    assert.strictEqual(lastUpdate().systemPrompt, '');
});

test('an instruction too long to show is not saved back truncated', async () => {
    // Measured, not assumed: personaOf clamps at LIMITS.freeText, so an
    // instruction one paragraph over the limit comes back short. An editor
    // that echoes a whole GET response — the shape A2 is building — would
    // write that truncation back and answer 200. The tail of an instruction
    // is usually the sharpest part of it.
    const pp = require('../../core/agentRuntime/personaPrompt');
    const long = `${'A'.repeat(pp.LIMITS.freeText)}\n\nAnd never quote a price.`;
    fx.agents.a1 = AGENT({ system_prompt: long });
    const projected = pp.personaOf(fx.agents.a1);
    assert.ok(projected.freeText.length < long.length, 'the fixture must actually be over the limit');

    await dispatch({ method: 'PUT', url: '/a1', body: { name: 'A', persona: projected } });
    // The outcome, not the internal: what reaches the store is the FULL stored
    // instruction, tail and all. (resolvePersonaWrite answers null — "I have no
    // prompt to write" — and the route's own fallback then supplies the stored
    // one. Asserting the null would pass even if that fallback broke.)
    assert.strictEqual(lastUpdate().systemPrompt, long);
});

test('…but a real edit of a long instruction still writes', async () => {
    // The guard must not make a long prompt uneditable. Anything that differs
    // from the projection is a person having typed something.
    const pp = require('../../core/agentRuntime/personaPrompt');
    const long = `${'A'.repeat(pp.LIMITS.freeText)}\n\nAnd never quote a price.`;
    fx.agents.a1 = AGENT({ system_prompt: long });
    const edited = { ...pp.personaOf(fx.agents.a1), freeText: 'You are support. Be brief.' };

    await dispatch({ method: 'PUT', url: '/a1', body: { name: 'A', persona: edited } });
    assert.strictEqual(lastUpdate().systemPrompt, 'You are support. Be brief.');
});

test('a prompt that fits is untouched by the guard', async () => {
    const pp = require('../../core/agentRuntime/personaPrompt');
    fx.agents.a1 = AGENT({ system_prompt: 'You are support.' });
    await dispatch({ method: 'PUT', url: '/a1', body: { name: 'A', persona: pp.personaOf(fx.agents.a1) } });
    assert.strictEqual(lastUpdate().systemPrompt, 'You are support.',
        'an unclamped round trip writes the same text back, which is a no-op, not a loss');
});

test('PUT with persona:null clears the column and keeps the sent prompt', async () => {
    fx.agents.a1 = AGENT();
    await dispatch({ method: 'PUT', url: '/a1', body: { name: 'A', systemPrompt: 'hand written', persona: null } });
    const { systemPrompt, opts } = lastUpdate();
    assert.strictEqual(systemPrompt, 'hand written');
    assert.strictEqual(opts.persona, null);
});

test('a persona-derived automation grant still goes through the tool clamp', async () => {
    // The one path that MINTS a grant server-side must not be the one path that
    // skips the normaliser every other grant passes.
    fx.agents.a1 = AGENT();
    fx.automations['auto-1'] = CALLABLE();
    await dispatch({
        method: 'PUT', url: '/a1',
        body: { name: 'A', config: { enabledIntegrations: [], tools: { gmail: { actions: 'not-an-array' } } }, persona: HANDOFF },
    });
    const { config } = lastUpdate();
    assert.deepStrictEqual(config.tools.automations, { 'auto-1': { confirm: 'ask' } });
    assert.deepStrictEqual(config.tools.gmail.actions, [], 'the clamp ran over the whole map, persona grant included');
});

test('a prototype-polluting key in `persona` is refused at the boundary, like one in `config`', async () => {
    fx.agents.a1 = AGENT();
    const res = await dispatch({
        method: 'PUT', url: '/a1',
        body: { name: 'A', persona: JSON.parse('{"who":"x","tone":{"__proto__":{"polluted":true}}}') },
    });
    assert.strictEqual(res.statusCode, 400);
    assert.match(res.body.error, /forbidden config key/);
    assert.strictEqual(fx.updateCalls.length, 0);
});

test('a persona save reports what did not stick', async () => {
    fx.agents.a1 = AGENT();
    fx.automations['auto-1'] = CALLABLE({ isActive: false });
    const res = await dispatch({
        method: 'PUT', url: '/a1',
        body: { name: 'A', config: { enabledIntegrations: [] }, persona: HANDOFF },
    });
    assert.ok(Array.isArray(res.body.warnings) && res.body.warnings.some(w => /auto-1/.test(w)));
});

// ── Whichever field the request actually changed wins ────────────────

test('a client that edits the PROMPT and echoes the persona back does not lose the edit', async () => {
    // The save shape that would otherwise silently delete a hand-typed prompt:
    // GET hands back a persona, the editor changes only the prompt box, and the
    // unchanged fields would render straight over the new text.
    const stored = { who: 'You are support.', tone: { chips: [], text: '' }, does: ['Answer'], doesNot: [], unknown: { mode: 'honest', automationId: null }, language: null, mode: 'fields', freeText: '' };
    fx.agents.a1 = AGENT({ persona: stored, system_prompt: 'You are support.\n\nWhat you do:\n- Answer' });

    await dispatch({
        method: 'PUT', url: '/a1',
        body: { name: 'A', systemPrompt: 'A prompt I typed by hand.', persona: stored },
    });
    const { systemPrompt, opts } = lastUpdate();
    assert.strictEqual(systemPrompt, 'A prompt I typed by hand.');
    assert.strictEqual(opts.persona.mode, 'free');
    assert.strictEqual(opts.persona.freeText, 'A prompt I typed by hand.',
        'the persona follows the prompt, so the two never describe different agents');
});

test('…but a changed persona still wins over an unchanged prompt', async () => {
    const stored = { who: 'You are support.', tone: { chips: [], text: '' }, does: ['Answer'], doesNot: [], unknown: { mode: 'honest', automationId: null }, language: null, mode: 'fields', freeText: '' };
    fx.agents.a1 = AGENT({ persona: stored, system_prompt: 'the old render' });

    await dispatch({
        method: 'PUT', url: '/a1',
        body: { name: 'A', systemPrompt: 'the old render', persona: { ...stored, who: 'You are the concierge.' } },
    });
    const { systemPrompt, opts } = lastUpdate();
    assert.strictEqual(opts.persona.mode, 'fields');
    assert.match(systemPrompt, /^You are the concierge\./);
});

test('a request that sends no persona is untouched by the rule', async () => {
    fx.agents.a1 = AGENT({ persona: { mode: 'free', freeText: 'x' }, system_prompt: 'x' });
    await dispatch({ method: 'PUT', url: '/a1', body: { name: 'A', systemPrompt: 'edited by hand' } });
    const { systemPrompt, opts } = lastUpdate();
    assert.strictEqual(systemPrompt, 'edited by hand');
    assert.strictEqual(opts.persona, undefined);
});
