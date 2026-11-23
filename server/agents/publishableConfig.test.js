/**
 * agents/publishableConfig.js — the anti-leak validation of an agent config's
 * references, the fold of its verdict, and the two together for a publish.
 * Stores and the tool policy are injected (no module mocking).
 *
 * Run: cd server && node --test agents/publishableConfig.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { publishableConfig, validateAgentConfigReferences, applyConfigValidation } = require('./publishableConfig');

const SKILLS = {
    's-orgA': { org_id: 'orgA', user_id: 'someone' },
    's-orgB': { org_id: 'orgB', user_id: 'someone' },
    's-personal': { org_id: null, user_id: 'owner' },
};
const KBS = {
    'kb-orgA': { organization_id: 'orgA', tenant_id: 'someone' },
    'kb-orgB': { organization_id: 'orgB', tenant_id: 'someone' },
    'kb-owned': { organization_id: null, tenant_id: 'owner' },
    'kb-chat-only': { organization_id: 'orgA', tenant_id: 'someone', chatOnly: true },
    'kb-system': { organization_id: null, tenant_id: 'system', _system: true },
};

const deps = (extra = {}) => ({
    kbStore: { getKB: async (id) => KBS[id] || null, isSystemKB: (kb) => !!kb?._system },
    skillStore: { getSkillScope: async (id) => SKILLS[id] || null },
    usageContexts: { kbUsableIn: (kb, surface) => !(kb.chatOnly && surface === 'agent') },
    ...extra,
});
const agent = (org = 'orgA', config = {}) => ({ id: 'ag1', owner_id: 'owner', organization_id: org, config });

test('no config: nothing to check', async () => {
    assert.deepStrictEqual(await validateAgentConfigReferences(agent(), null, deps()), { warnings: [], droppedSkillIds: [], droppedKbIds: [], tools: null });
});

test('knowledge bases: same org, owned and system pass; an existing cross-org base refuses with 400', async () => {
    const ok = await validateAgentConfigReferences(agent(), { knowledge_base_ids: ['kb-orgA', 'kb-owned', 'kb-system'] }, deps());
    assert.deepStrictEqual(ok.droppedKbIds, []);
    await assert.rejects(() => validateAgentConfigReferences(agent(), { knowledge_base_ids: ['kb-orgB'] }, deps()),
        (e) => e.status === 400 && /knowledge base kb-orgB/.test(e.message));
});

test('knowledge bases: a deleted or chat-only base is dropped with a warning, so the agent can still be saved', async () => {
    // The editor sends the whole config on every autosave and cannot show a
    // base that is gone, so a refusal here made the agent unsaveable for good.
    const v = await validateAgentConfigReferences(agent(),
        { knowledge_base_ids: ['kb-orgA', 'kb-missing', 'kb-chat-only'] }, deps());
    assert.deepStrictEqual(v.droppedKbIds, ['kb-missing', 'kb-chat-only']);
    assert.deepStrictEqual(v.warnings, ['knowledge base kb-missing (no longer exists)', 'knowledge base kb-chat-only (not available for agents)']);
    const folded = applyConfigValidation({ knowledge_base_ids: ['kb-orgA', 'kb-missing', 'kb-chat-only'], x: 1 }, v);
    assert.deepStrictEqual(folded, { knowledge_base_ids: ['kb-orgA'], x: 1 });
});

test('knowledge bases: a lookup that fails refuses the save instead of unlinking a base that may still exist', async () => {
    const down = deps({ kbStore: { getKB: async () => { throw new Error('db down'); }, isSystemKB: () => false } });
    await assert.rejects(() => validateAgentConfigReferences(agent(), { knowledge_base_ids: ['kb-orgA'] }, down),
        (e) => e.status === 503);
});

test('skills: a foreign skill is dropped with a warning, never refused', async () => {
    const v = await validateAgentConfigReferences(agent(), { attachedSkillIds: ['s-orgA', 's-orgB', 's-personal'] }, deps());
    assert.deepStrictEqual(v.droppedSkillIds, ['s-orgB']);
    assert.deepStrictEqual(v.warnings, ['skill s-orgB']);
    const orgless = await validateAgentConfigReferences(agent(null), { attachedSkillIds: ['s-personal', 's-orgA'] }, deps());
    assert.deepStrictEqual(orgless.droppedSkillIds, ['s-orgA'], 'an org-less agent keeps only its owner\'s personal skills');
});

test('stores may be given as loaders (the routes hand theirs in that way)', async () => {
    let loaded = 0;
    const lazy = deps({ skillStore: () => { loaded++; return { getSkillScope: async (id) => SKILLS[id] || null }; } });
    await validateAgentConfigReferences(agent(), { knowledge_base_ids: ['kb-orgA'] }, lazy);
    assert.strictEqual(loaded, 0, 'only loaded when the config has skills');
    await validateAgentConfigReferences(agent(), { attachedSkillIds: ['s-orgA'] }, lazy);
    assert.strictEqual(loaded, 1);
});

test('tool grants: clamped through the policy; an unavailable policy keeps them as sent, with a warning', async () => {
    const policy = {
        resolveLentProviders: async () => [],
        normaliseToolsConfig: () => ({ tools: { gmail: { confirm: 'ask' } }, warnings: ['tools.gmail clamped'] }),
    };
    const v = await validateAgentConfigReferences(agent(), { tools: { gmail: { confirm: 'direct' } } }, deps({ toolPolicy: policy }));
    assert.deepStrictEqual(v.tools, { gmail: { confirm: 'ask' } });
    assert.deepStrictEqual(v.warnings, ['tools.gmail clamped']);

    const broken = { resolveLentProviders: async () => { throw new Error('policy down'); } };
    const kept = await validateAgentConfigReferences(agent(), { tools: { gmail: { confirm: 'direct' } } }, deps({ toolPolicy: broken }));
    assert.strictEqual(kept.tools, null);
    assert.deepStrictEqual(kept.warnings, ['tool grants could not be validated']);
});

test('applyConfigValidation folds both halves and is a no-op without a verdict', () => {
    const config = { attachedSkillIds: ['a', 'b'], tools: { gmail: '*' }, other: 1 };
    assert.deepStrictEqual(applyConfigValidation(config, { droppedSkillIds: ['b'], tools: {} }),
        { attachedSkillIds: ['a'], tools: {}, other: 1 });
    assert.strictEqual(applyConfigValidation(config, null), config);
    assert.strictEqual(applyConfigValidation(config, { droppedSkillIds: [], tools: null }), config);
    assert.strictEqual(applyConfigValidation(null, { tools: {} }), null);
});

test('publishableConfig validates the concept against the owner and applies the verdict to a copy', async () => {
    const a = agent('orgA', { attachedSkillIds: ['s-orgA', 's-orgB'], knowledge_base_ids: ['kb-orgA'] });
    const out = await publishableConfig(a, {
        validateAgentConfigReferences: (ag, cfg) => validateAgentConfigReferences(ag, cfg, deps()),
    });
    assert.deepStrictEqual(out.config.attachedSkillIds, ['s-orgA']);
    assert.deepStrictEqual(out.warnings, ['skill s-orgB']);
    assert.deepStrictEqual(a.config.attachedSkillIds, ['s-orgA', 's-orgB'], 'the concept itself is untouched');
});

test('publishableConfig throws what the validation throws, and uses injected halves', async () => {
    await assert.rejects(() => publishableConfig(agent('orgA', { knowledge_base_ids: ['kb-orgB'] }), {
        validateAgentConfigReferences: (ag, cfg) => validateAgentConfigReferences(ag, cfg, deps()),
    }), (e) => e.status === 400);

    const calls = [];
    const out = await publishableConfig({ config: undefined }, {
        validateAgentConfigReferences: async (ag, cfg) => { calls.push(cfg); return { warnings: ['w'] }; },
        applyConfigValidation: (cfg) => ({ ...cfg, folded: true }),
    });
    assert.deepStrictEqual(calls, [{}], 'a missing config is validated as {}');
    assert.deepStrictEqual(out, { warnings: ['w'], config: { folded: true } });
});
