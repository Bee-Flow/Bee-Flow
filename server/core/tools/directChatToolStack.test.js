/**
 * DB-free tests for buildDirectChatToolStack (H6 adoption lock).
 *
 * Pins the contract directChat.js and swarmRuntime.js both rely on:
 * component→function-schema mapping (secure/defaulted inputs hidden, required
 * built from required:true), tier filtering via direct_chat_tier_tools,
 * integration merge deduped by function name, n8nOrgId passthrough, and the
 * failure policy: default = degrade to component tools (swarm), strict = throw
 * (direct chat keeps its historical fail-the-turn behavior).
 */

const test = require('node:test');
const assert = require('node:assert');

const { installResolveStub } = require('../../testUtils/stubRequire');

const fx = {
    components: [],
    tierTools: null,
    integrations: { tools: [], n8nOrgId: null },
    integrationsThrow: null,
    lastIntegrationArgs: null,
};

const restore = installResolveStub({
    '../cms/componentManager': { getComponents: () => fx.components },
    '../../stores/configStore': { getConfig: async () => fx.tierTools },
    '../integrations/integrationTools': {
        getIntegrationTools: async (opts) => {
            fx.lastIntegrationArgs = opts;
            if (fx.integrationsThrow) throw fx.integrationsThrow;
            return fx.integrations;
        },
    },
});

const { buildDirectChatToolStack } = require('./directChatToolStack');

test.after(() => restore());
test.beforeEach(() => {
    fx.components = [];
    fx.tierTools = null;
    fx.integrations = { tools: [], n8nOrgId: null };
    fx.integrationsThrow = null;
    fx.lastIntegrationArgs = null;
});

const COMP = {
    id: 'comp-1',
    definition: {
        name: 'Comp One',
        description: 'Does things',
        directChatEnabled: true,
        inputs: {
            visible: { type: 'string', description: 'a visible input', required: true },
            optional: { type: 'number' },
            secret: { type: 'string', secure: true },
            defaulted: { type: 'string', default: 'x' },
            shorthand: 'string',
        },
    },
};

test('component mapping: secure + defaulted inputs hidden, required built, shorthand tolerated', async () => {
    fx.components = [COMP, { id: 'comp-off', definition: { directChatEnabled: false } }];
    const { tools } = await buildDirectChatToolStack({ userId: 'u1', session: {} });
    assert.strictEqual(tools.length, 1);
    const fn = tools[0].function;
    assert.strictEqual(fn.name, 'comp-1');
    assert.strictEqual(fn.description, 'Does things');
    assert.deepStrictEqual(Object.keys(fn.parameters.properties).sort(), ['optional', 'shorthand', 'visible']);
    assert.deepStrictEqual(fn.parameters.properties.visible, { type: 'string', description: 'a visible input' });
    assert.deepStrictEqual(fn.parameters.properties.shorthand, { type: 'string', description: '' });
    assert.deepStrictEqual(fn.parameters.required, ['visible']);
});

test('description fallback chain: description → name → id', async () => {
    fx.components = [
        { id: 'c-name', definition: { directChatEnabled: true, name: 'Named' } },
        { id: 'c-id', definition: { directChatEnabled: true } },
    ];
    const { tools } = await buildDirectChatToolStack({});
    assert.strictEqual(tools[0].function.description, 'Named');
    assert.strictEqual(tools[1].function.description, 'c-id');
});

test('tier filter: direct_chat_tier_tools[resolvedTier] wins over directChatEnabled', async () => {
    fx.components = [
        COMP,
        { id: 'comp-2', definition: { directChatEnabled: false, description: 'off by default' } },
    ];
    fx.tierTools = { fast: ['comp-2'] };
    const { tools } = await buildDirectChatToolStack({ resolvedTier: 'fast' });
    assert.deepStrictEqual(tools.map(t => t.function.name), ['comp-2']);

    // absent tier entry → falls back to directChatEnabled
    const { tools: fallback } = await buildDirectChatToolStack({ resolvedTier: 'other' });
    assert.deepStrictEqual(fallback.map(t => t.function.name), ['comp-1']);
});

test('integration tools merge deduped by function name; n8nOrgId passthrough', async () => {
    fx.components = [COMP];
    fx.integrations = {
        n8nOrgId: 'org-n8n',
        tools: [
            { type: 'function', function: { name: 'comp-1', description: 'dup — must not shadow' } },
            { type: 'function', function: { name: 'agent_search', description: 'search' } },
        ],
    };
    const { tools, n8nOrgId } = await buildDirectChatToolStack({ userId: 'u1' });
    assert.strictEqual(n8nOrgId, 'org-n8n');
    assert.deepStrictEqual(tools.map(t => t.function.name), ['comp-1', 'agent_search']);
    assert.strictEqual(tools[0].function.description, 'Does things', 'component wins the name collision');
});

test('extraEnabledApps (skill-scoped apps) forwarded to getIntegrationTools; default null', async () => {
    await buildDirectChatToolStack({ userId: 'u1', extraEnabledApps: ['fireflies', 'gmail'] });
    assert.deepStrictEqual(fx.lastIntegrationArgs.extraEnabledApps, ['fireflies', 'gmail']);

    await buildDirectChatToolStack({ userId: 'u1' });
    assert.strictEqual(fx.lastIntegrationArgs.extraEnabledApps, null, 'swarm callers stay unaffected');
});

test('integration failure: default degrades to component tools; strict throws', async () => {
    fx.components = [COMP];
    fx.integrationsThrow = new Error('oauth down');

    const { tools, n8nOrgId } = await buildDirectChatToolStack({ userId: 'u1' });
    assert.deepStrictEqual(tools.map(t => t.function.name), ['comp-1']);
    assert.strictEqual(n8nOrgId, null);

    await assert.rejects(
        buildDirectChatToolStack({ userId: 'u1', strict: true }),
        /oauth down/,
    );
});
