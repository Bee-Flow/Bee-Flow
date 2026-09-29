/**
 * What the AI step editor is told about an agent and a skill (handoff 5,
 * round 3): version and scope, the knowledge bases and skills the agent
 * brings as the editor may see them, its tools grouped per integration, and a
 * skill's output fields. Every reader is injected; no module mocking.
 *
 * Run: cd server && node --test routes/automation/agentStepCatalog.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const C = require('./agentStepCatalog');

const td = (name, extra = {}) => ({ type: 'function', function: { name }, ...extra });
const resolveIntegration = (name) => {
    if (name.startsWith('gmail_')) return { integration: 'gmail', label: 'Gmail' };
    if (name.startsWith('drive_')) return { integration: 'drive', label: 'Google Drive' };
    return null;
};

function deps(over = {}) {
    const kbRows = { kb1: { id: 'kb1', name: 'Price list', ok: true }, kb2: { id: 'kb2', name: 'Secret', ok: false } };
    return {
        kbStore: { getKB: async (id) => kbRows[id] || null, canUserAccessKB: (kb) => !!kb && kb.ok },
        kbVisibility: {
            async filterKbIdsForUser(ids, opts) {
                const out = [];
                for (const id of ids) {
                    const kb = await opts.deps.kbStore.getKB(id);
                    if (opts.deps.kbStore.canUserAccessKB(kb)) out.push(id);
                }
                return out;
            },
        },
        skillStore: {
            getSkillsByIds: async (ids) => ids.filter((id) => id !== 'sk_hidden').map((id) => ({ id, name: `Name ${id}` })).reverse(),
            getSkill: async (id) => (id === 'sk_quote'
                ? { id, name: 'Quote', description: 'Writes quotes', version: 3, outputSchema: { type: 'object', properties: { total: { type: 'number', title: 'Total' }, due: { type: 'string', format: 'date' } } } }
                : null),
        },
        resolveIntegration,
        log: { warn: () => {} },
        ...over,
    };
}

const CTX = { userId: 'u1', orgId: 'org1', userGroupIds: [] };

test('tools are grouped per integration; a group is struck only when every tool in it is withheld', () => {
    const groups = C.groupToolsByIntegration({
        allowed: ['gmail_search'],
        withheld: [
            { name: 'gmail_compose', reason: 'confirm' },
            { name: 'drive_upload_file', reason: 'confirm' },
            { name: 'automation_r1', reason: 'permission' },
        ],
        toolDefs: [td('automation_r1', { __automation: { id: 'r1' } })],
        resolveIntegration,
    });
    assert.deepStrictEqual(groups, [
        { integration: 'gmail', label: 'Gmail', tools: ['gmail_search', 'gmail_compose'], withheld: false, reason: null, withheldTools: [{ name: 'gmail_compose', reason: 'confirm' }] },
        { integration: 'drive', label: 'Google Drive', tools: ['drive_upload_file'], withheld: true, reason: 'confirm', withheldTools: [{ name: 'drive_upload_file', reason: 'confirm' }] },
        { integration: 'automations', label: 'Automations', tools: ['automation_r1'], withheld: true, reason: 'permission', withheldTools: [{ name: 'automation_r1', reason: 'permission' }] },
    ]);
});

test('MCP, custom, building blocks, skills and unknown names each land in a group of their own', () => {
    const groups = C.groupToolsByIntegration({
        allowed: ['srv_read', 'ci_post', 'step_weekly', 'activate_skill', 'mystery'],
        toolDefs: [
            td('srv_read', { _mcp: { serverId: 'srv', serverName: 'Wiki' } }),
            td('ci_post', { _custom: { integrationId: 'ci' } }),
            td('step_weekly', { __step: { id: 'b1' } }),
        ],
        resolveIntegration,
    });
    assert.deepStrictEqual(groups.map((g) => [g.integration, g.label]), [
        ['mcp:srv', 'Wiki'], ['custom:ci', 'Custom integration'], ['building_blocks', 'Building blocks'],
        ['skills', 'Skills'], ['other', 'Other tools'],
    ]);
});

test('scope and version read off the runtime row', () => {
    assert.strictEqual(C.agentScope({ is_published: true, organization_id: 'org1' }), 'org');
    assert.strictEqual(C.agentScope({ is_published: false, organization_id: 'org1' }), 'personal');
    assert.strictEqual(C.agentVersion({ published_version: 4 }), 4);
    assert.strictEqual(C.agentVersion({ published_version: 0 }), null);
});

test('the agent description names only what the editor may see, in the agent\'s order', async () => {
    const binding = {
        agent: { is_published: true, organization_id: 'org1', published_version: 2 },
        config: { knowledge_base_ids: ['kb1', 'kb2', 'kb_gone'], attachedSkillIds: ['sk_a', 'sk_hidden', 'sk_b'] },
    };
    const gate = { tools: [td('gmail_search')], toolDefs: [] };
    const out = await C.describeAgentForStep({ binding, gate, withheld: [{ name: 'gmail_compose', reason: 'confirm' }], ctx: CTX, deps: deps() });
    assert.strictEqual(out.version, 2);
    assert.strictEqual(out.scope, 'org');
    assert.deepStrictEqual(out.knowledgeBases, [{ id: 'kb1', name: 'Price list' }]);
    assert.deepStrictEqual(out.skills, [
        { id: 'sk_a', name: 'Name sk_a', fromAgent: true },
        { id: 'sk_b', name: 'Name sk_b', fromAgent: true },
    ]);
    assert.deepStrictEqual(out.tools.map((g) => g.integration), ['gmail']);
});

test('a list that cannot be read is null, not empty', async () => {
    const broken = deps({
        kbVisibility: { filterKbIdsForUser: async () => { throw new Error('kb down'); } },
        skillStore: { getSkillsByIds: async () => { throw new Error('skills down'); } },
    });
    const out = await C.describeAgentForStep({
        binding: { agent: {}, config: { knowledge_base_ids: ['kb1'], attachedSkillIds: ['sk_a'] } },
        gate: { tools: [] }, withheld: [], ctx: CTX, deps: broken,
    });
    assert.strictEqual(out.knowledgeBases, null);
    assert.strictEqual(out.skills, null);
    assert.deepStrictEqual(out.tools, []);
});

test('an agent with nothing attached says so with empty lists', async () => {
    const out = await C.describeAgentForStep({ binding: { agent: {}, config: {} }, gate: { tools: [] }, withheld: [], ctx: CTX, deps: deps() });
    assert.deepStrictEqual(out.knowledgeBases, []);
    assert.deepStrictEqual(out.skills, []);
});

test('a skill describes its output fields for "Continues as"', async () => {
    const out = await C.describeSkillForStep({ skillId: 'sk_quote', orgId: 'org1', userId: 'u1', deps: deps() });
    assert.deepStrictEqual(out, {
        id: 'sk_quote', name: 'Quote', description: 'Writes quotes', version: 3,
        outputSchema: { type: 'object', properties: { total: { type: 'number', title: 'Total' }, due: { type: 'string', format: 'date' } } },
        outputFields: [{ key: 'total', type: 'number', title: 'Total' }, { key: 'due', type: 'datetime', title: null }],
    });
});

test('a skill the editor cannot use is null, whatever the reason', async () => {
    assert.strictEqual(await C.describeSkillForStep({ skillId: 'sk_other', orgId: 'org1', userId: 'u1', deps: deps() }), null);
    assert.strictEqual(await C.describeSkillForStep({ skillId: '  ', orgId: 'org1', userId: 'u1', deps: deps() }), null);
});

test('a skill without output fields hands on an empty list and a null schema', async () => {
    const d = deps({ skillStore: { getSkill: async (id) => ({ id, name: 'Plain', version: 1, outputSchema: null }) } });
    const out = await C.describeSkillForStep({ skillId: 'sk_plain', orgId: 'org1', userId: 'u1', deps: d });
    assert.strictEqual(out.outputSchema, null);
    assert.deepStrictEqual(out.outputFields, []);
});
