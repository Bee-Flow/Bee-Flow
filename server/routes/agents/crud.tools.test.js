/**
 * Per-action tool grants on the WRITE side (A1): the clamp that
 * validateAgentConfigReferences applies to `config.tools`, and the fold that
 * both writers of a config — PUT /agents/:id and POST
 * /agents/:id/publish-version — share.
 *
 * The clamp is not the enforcement layer (the runtime re-clamps on every read
 * and refuses by tool name at dispatch). It exists so what the editor reads
 * back is what will actually run: a picker that shows "send without asking"
 * while the runtime always asks is a lie the user has no way to see through.
 *
 * crud.js's heavy top-level deps are stubbed through the Module resolve hook,
 * as in crud.test.js; toolPolicy's registry is stubbed too so the assertions
 * describe a shape rather than this week's integrations, while the effect
 * classes still come from the real sideEffectMap.
 *
 * Run: cd server && node --test --test-force-exit routes/agents/crud.tools.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

const noop = () => {};
const mw = () => (req, res, next) => next();

const CRUD_MOCKS = {
    '../../stores/agentStore': {},
    '../../core/agentRuntime': {},
    '../../core/aiAgent': { getAIConfig: noop, getProviderForModel: noop },
    '../../core/llm/modelResolver': { normalizeTierModel: (m) => m },
    '../../stores/configStore': {},
    '../../auth': {
        requirePermission: mw,
        requireActiveOrgForMutations: mw,
        OrgRoles: {}, SystemRoles: {},
        resolveUserOrgIds: async () => new Set(),
        canSeePublished: () => false,
        resolveUserGroups: async () => [],
        assertUserCanUseOrg: async () => {},
        validateSharedGroupsForOrg: async () => [],
    },
    '../../stores/memoryStore': {},
    '../../utils/routeHelpers': { getEffectiveUserId: () => 'owner', getUserAuth: () => ({}) },
    '../../stores/userStore': {},
    '../../stores/usageStore': {},
    '../../core/entitlements/limits': { checkSubscriptionLimits: async () => ({}), checkResourceLimits: async () => ({}) },
    '../../core/http/sseHelpers': { setupSSE: noop, sendSSEError: noop, persistAndTitle: async () => {}, getOrCreateAgentConversation: async () => {} },
    '../../stores/skillStore': { getSkillScope: async () => null },
    '../../stores/knowledgeBases': { getKB: async () => null, isSystemKB: () => false },
};
const POLICY_MOCKS = {
    '../../../automation/toolRegistry': {
        TOOL_REGISTRY: [{ app: 'gmail', label: 'Gmail' }],
        INLINE_TOOL_APPS: [],
        // De lijst die de attributie-index leest: registry PLUS de apps die hun
        // tools inline injecteren (A2-1, automation/toolRegistry.js).
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
    },
    '../../integrations/connectionResolution': {
        isLendingEnabled: () => false,          // the product default
        providerForTool: () => 'google',
    },
};

const MOCK_IDS = { crud: {}, policy: {} };
for (const [group, map] of [['crud', CRUD_MOCKS], ['policy', POLICY_MOCKS]]) {
    for (const [request, exportsObj] of Object.entries(map)) {
        const mockId = `mock:crud-tools:${group}:${request}`;
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

const { validateAgentConfigReferences, applyConfigValidation } = require('./crud');
test.after(() => { Module._resolveFilename = originalResolve; });

const AGENT = { id: 'a1', owner_id: 'owner', organization_id: null };

// ── No map, no acquisition ──────────────────────────────────────────

test('a config without a grants map gets none — saving must not opt an agent in', async () => {
    const config = { enabledIntegrations: ['gmail'], knowledge_base_ids: [] };
    const v = await validateAgentConfigReferences(AGENT, config);

    assert.strictEqual(v.tools, null);
    assert.deepStrictEqual(applyConfigValidation(config, v), config,
        'every agent in the product is in this state; a save may not change one byte of it');
});

// ── The clamp ───────────────────────────────────────────────────────

test('a PUT with a send action set to "direct" reads back as "ask"', async () => {
    const config = { tools: { gmail: { actions: ['gmail_compose'], confirm: 'direct' } } };
    const v = await validateAgentConfigReferences(AGENT, config);

    assert.strictEqual(v.tools.gmail.confirm, 'ask');
    assert.ok(v.warnings.some(w => /forced to "ask"/.test(w)),
        'the editor is told why its choice did not stick, instead of silently seeing it change');
    assert.strictEqual(applyConfigValidation(config, v).tools.gmail.confirm, 'ask',
        'and the clamped value is what gets persisted');
});

test('an action nobody offers is dropped, not stored as an inert grant', async () => {
    const v = await validateAgentConfigReferences(AGENT, {
        tools: { gmail: { actions: ['gmail_search', 'gmail_delete_everything'] } },
    });

    assert.deepStrictEqual(v.tools.gmail.actions, ['gmail_search']);
    assert.ok(v.warnings.some(w => /gmail_delete_everything/.test(w)));
});

test('an unknown app keeps its actions — a name the registry cannot see is not a typo', async () => {
    // MCP servers and org custom integrations load their tools at runtime, so
    // there is no catalogue to check them against. Deleting the user's pick on
    // a guess is worse than an entry that turns out inert.
    const v = await validateAgentConfigReferences(AGENT, {
        tools: { 'mcp:tuya': { actions: ['tuya_list_devices'] } },
    });
    assert.deepStrictEqual(v.tools['mcp:tuya'].actions, ['tuya_list_devices']);
});

test('actAs "owner" is refused while lending is off', async () => {
    const v = await validateAgentConfigReferences(AGENT, {
        tools: { gmail: { actions: ['gmail_search'], actAs: 'owner' } },
    });
    assert.strictEqual(v.tools.gmail.actAs, 'viewer');
});

test('a junk map is clamped, not thrown on, and never widened', async () => {
    const v = await validateAgentConfigReferences(AGENT, {
        tools: { gmail: 'nope', 'mcp:tuya': { actions: { pick: 'tuya_list_devices' } } },
    });

    // KEPT, granting nothing. Asserting the DROP here (which this line used to
    // do) let the widening through the front door: this route WRITES what the
    // clamp returns, and a missing entry means "every action of this app" to
    // every reader in toolPolicy.js — so `{gmail: 'nope'}` was persisted as
    // the whole of Gmail.
    assert.ok('gmail' in v.tools, 'an unreadable entry survives — dropping it granted the whole app');
    assert.deepStrictEqual(v.tools.gmail.actions, [], 'granting nothing');
    assert.deepStrictEqual(v.tools['mcp:tuya'].actions, [], 'and an unreadable action list grants nothing');
});

// ── The widening a PUT used to persist ──────────────────────────────
// This side WRITES what the clamp returns, so "never widens" has to hold here
// or a client's typo permanently grows the agent's toolbelt.

test('a bare string where a list belongs is stored as no actions, not as every action', async () => {
    const config = { tools: { gmail: { actions: 'gmail_search' } } };
    const v = await validateAgentConfigReferences(AGENT, config);

    assert.notStrictEqual(v.tools.gmail.actions, '*');
    assert.deepStrictEqual(v.tools.gmail.actions, []);
    assert.ok(v.warnings.some(w => /gmail/.test(w) && /no actions granted/.test(w)),
        'the editor is told, instead of quietly getting Gmail in full');

    const saved = applyConfigValidation(config, v);
    assert.deepStrictEqual(saved.tools.gmail.actions, [],
        'and what is persisted is the narrow reading — this is the line that used to write "*" into the row');
});

test('the app bound widens nothing either — the surplus is stored as no actions', async () => {
    // The same failure through the SIZE door. Truncating the app list dropped
    // the entries past the bound, and a dropped entry is not a smaller grant:
    // a missing entry means every action of that app. So the narrow grant on
    // app 201 came back as the whole app, and this side wrote it to the row.
    const P = require('../../core/agentRuntime/toolPolicy');
    const many = {};
    for (let i = 0; i < P.MAX_APP_ENTRIES; i++) many[`filler_${i}`] = { actions: [] };
    many.gmail = { actions: ['gmail_search'] };           // entry #201: the real grant
    const config = { tools: many };

    assert.ok(!P.isToolAllowed('gmail_compose', many), 'as sent, this map is narrow');

    const v = await validateAgentConfigReferences(AGENT, config);
    const saved = applyConfigValidation(config, v);

    assert.deepStrictEqual(saved.tools.gmail.actions, [],
        'past the bound is "grants nothing" — spelled out, because leaving it out is what opened the app');
    assert.ok(!P.isToolAllowed('gmail_compose', saved.tools),
        'and what is persisted may not grant more than what was sent');
    assert.ok(v.warnings.some(w => new RegExp(String(P.MAX_APP_ENTRIES)).test(w)),
        'with the owner told, so they prune the map instead of losing grants silently');
});

test('a datatable grant survives the write, clamped — because something enforces it now', async () => {
    // It was REFUSED here for two releases (nothing read `scope`/`columns`, and
    // a stored limit nobody applies is worse than no feature). A1c wired
    // `datatable_query` to both halves, so it is stored — and clamped on the
    // way in exactly like every other section: an unreadable access answer
    // lands on 'own', never on 'all'.
    const config = {
        tools: {
            gmail: { actions: ['gmail_search'] },
            datatables: { t1: { scope: 'all', columns: ['naam'] }, t2: { scope: 'everything' } },
        },
    };
    const v = await validateAgentConfigReferences(AGENT, config);

    assert.deepStrictEqual(v.tools.datatables.t1, { scope: 'all', columns: ['naam'] });
    assert.strictEqual(v.tools.datatables.t2.scope, 'own', 'a scope nobody can read narrows');
    assert.ok(v.warnings.some(w => /datatables\.t2/.test(w)), 'and the caller hears which half was refused');

    const saved = applyConfigValidation(config, v);
    assert.deepStrictEqual(saved.tools.gmail.actions, ['gmail_search'], 'the rest of the curation is untouched');
    assert.strictEqual(saved.tools.datatables.t2.scope, 'own',
        'and the clamp reaches the ROW — it was never a clamp if the raw map is what is stored');
});

test('the clamp is idempotent — re-saving what came back changes nothing', async () => {
    const first = await validateAgentConfigReferences(AGENT, {
        tools: {
            gmail: { actions: ['gmail_compose'], confirm: 'direct', actAs: 'owner' },
        },
    });
    const second = await validateAgentConfigReferences(AGENT, { tools: first.tools });

    assert.deepStrictEqual(second.tools, first.tools);
    assert.deepStrictEqual(second.warnings, [],
        'a second pass must find nothing to complain about, or every autosave nags the editor');
});

// ── The fold both writers share ─────────────────────────────────────

test('applyConfigValidation folds BOTH halves of a verdict', async () => {
    const config = {
        attachedSkillIds: ['s-keep', 's-drop'],
        tools: { gmail: { actions: ['gmail_compose'], confirm: 'direct' } },
        enabledIntegrations: ['gmail'],
    };
    const out = applyConfigValidation(config, {
        droppedSkillIds: ['s-drop'],
        tools: { gmail: { actions: ['gmail_compose'], confirm: 'ask', actAs: 'viewer' } },
    });

    assert.deepStrictEqual(out.attachedSkillIds, ['s-keep']);
    assert.strictEqual(out.tools.gmail.confirm, 'ask');
    assert.deepStrictEqual(out.enabledIntegrations, ['gmail'], 'the rest of the config is untouched');
    assert.deepStrictEqual(config.attachedSkillIds, ['s-keep', 's-drop'], 'the caller\'s object is not mutated');
});

test('applyConfigValidation is a no-op for a verdict with nothing to fold', () => {
    const config = { enabledIntegrations: ['gmail'] };
    assert.strictEqual(applyConfigValidation(config, { droppedSkillIds: [], tools: null }), config);
    assert.strictEqual(applyConfigValidation(config, null), config);
    assert.strictEqual(applyConfigValidation(null, { tools: {} }), null);
});

// ── A map that clamps to nothing is STORED as nothing ───────────────
// The other half of "refused, not stored". This used to keep the caller's raw
// map whenever the clamp emptied it, for fear that a stored `{}` would read as
// a curation. It does not — `hasCuratedGrants` asks the contents — so the
// guard bought nothing and cost the refusal: a PUT carrying only a refused
// section was persisted VERBATIM and handed straight back to the editor, which
// is a limit that enforces nothing, believed by the owner who set it.

test('a tools value nobody can read is stored as the refusal it clamps to', async () => {
    const config = { enabledIntegrations: ['gmail'], tools: { gmail: 'nope' } };
    const v = await validateAgentConfigReferences(AGENT, config);

    assert.deepStrictEqual(v.tools, { gmail: { actions: [], actAs: 'viewer' } },
        'the clamp keeps the unreadable entry and grants nothing through it');
    assert.ok(v.warnings.some(w => /gmail/.test(w)), 'and says so, so the editor is not left guessing');

    const out = applyConfigValidation(config, v);
    assert.deepStrictEqual(out.tools, { gmail: { actions: [], actAs: 'viewer' } },
        'what is persisted is what the clamp read, not what the caller sent');
    assert.deepStrictEqual(out.enabledIntegrations, ['gmail']);

    const policy = require('../../core/agentRuntime/toolPolicy');
    assert.ok(!policy.isToolAllowed('gmail_compose', out.tools),
        'and the row that was written may not offer what the caller never managed to grant');
    // The cost, pinned rather than left to be found: a stored refusal IS
    // content, so this row does count as a curation and the agent enters the
    // confirmation regime. That is the closed side of the trade — the open
    // side was handing an app back in full, which this layer may not do.
    assert.strictEqual(policy.hasCuratedGrants(out.tools), true,
        'a refusal is a thing someone can read back — unlike the empty map it used to become');
});

test('a PUT carrying ONLY a refused section stores nothing — not the refused section', async () => {
    // The exact shape that leaked: the clamp refuses a section and the map is
    // then empty, which is precisely when the row used to keep the RAW value —
    // so `GET /agents/:id` gave the editor back the limit it had just been
    // refused. (`datatables` was the original example. It is stored now that
    // `datatable_query` enforces it, so the case moved to the test above and a
    // malformed `automations` carries the shape here.)
    // A RESERVED section that is not an object is dropped: `automations`
    // absent means "no automation is granted", so dropping it narrows. An APP
    // entry is the mirror image — absent means "every action" — so that one
    // is kept as a refusal instead. Both shapes are asserted here together
    // precisely because the same input shape gets opposite treatment, and the
    // reason is the direction the absence reads in.
    for (const [raw, expected] of [
        [{ automations: ['a1', 'a2'] }, {}],
        [{ gmail: ['gmail_search'] }, { gmail: { actions: [], actAs: 'viewer' } }],
    ]) {
        const config = { name: 'A', tools: raw };
        const v = await validateAgentConfigReferences(AGENT, config);

        assert.deepStrictEqual(v.tools, expected, `${Object.keys(raw)[0]}: refused, so nothing is granted`);
        assert.ok(v.warnings.length > 0, 'and refused out loud');

        const out = applyConfigValidation(config, v);
        assert.deepStrictEqual(out.tools, expected,
            'the refusal has to survive the save, or it was never a refusal');
        assert.strictEqual(out.name, 'A', 'the rest of the config is untouched');
    }
});

test('a real curation is still folded in', async () => {
    const config = { tools: { gmail: { actions: ['gmail_search'] } } };
    const v = await validateAgentConfigReferences(AGENT, config);

    assert.deepStrictEqual(applyConfigValidation(config, v).tools.gmail.actions, ['gmail_search'],
        'the emptiness rule must not swallow the normal path');
});
