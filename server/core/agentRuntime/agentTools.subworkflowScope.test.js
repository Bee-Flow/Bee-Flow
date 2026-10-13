/**
 * Subworkflows are offered as agent tools per organisation, never across them.
 *
 * GET /agents/meta/components is open on purpose (metadata for the guest chat
 * UI), and it used to append every row of the workflows table that carried a
 * subworkflow trigger: `getAllWorkflows()` is an unscoped SELECT. So an
 * anonymous caller got the name, description and input schema of every
 * subworkflow of every organisation, and an agent in one org was offered
 * another org's subworkflows as tools (getAgentTools read the same list).
 *
 * What this file pins, through the real filters with the stores swapped in
 * through agentTools._setDepsForTests:
 *
 *   - no user (the anonymous catalogue): file components only;
 *   - a signed-in user: their org's subworkflows, colleagues' included (that is
 *     what a single-org installation always showed), and no other org's;
 *   - a user id that no longer resolves: no subworkflows;
 *   - a user without an organisation: only their own;
 *   - an agent: the subworkflows of its OWNER's org, none for an ownerless one.
 *
 * Run: cd server && node --test core/agentRuntime/agentTools.subworkflowScope.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');

const USERS = {
    'u-a1': { id: 'u-a1', organizationId: 'org-a' },
    'u-a2': { id: 'u-a2', organizationId: 'org-a' },
    'u-b1': { id: 'u-b1', organizationId: 'org-b' },
    'u-solo': { id: 'u-solo', organizationId: null },
};

const trigger = (name) => ({
    id: 't1', type: 'trigger-subworkflow',
    data: { inputValues: { workflowDescription: `Secret process of ${name}`, inputs: [{ name: 'case', type: 'string' }] } },
});
const WORKFLOWS = [
    { id: 'wf-a1', name: 'A1 payroll', owner_id: 'u-a1', nodes: [trigger('A1')] },
    { id: 'wf-a2', name: 'A2 onboarding', owner_id: 'u-a2', nodes: [trigger('A2')] },
    { id: 'wf-b1', name: 'B1 layoffs', owner_id: 'u-b1', nodes: [trigger('B1')] },
    { id: 'wf-solo', name: 'Solo notes', owner_id: 'u-solo', nodes: [trigger('solo')] },
    { id: 'wf-plain', name: 'Not a subworkflow', owner_id: 'u-a1', nodes: [{ id: 'n', type: 'trigger-manual' }] },
];

const AGENTS = {
    'agent-b': { id: 'agent-b', userId: 'u-b1', config: {} },
    'agent-ownerless': { id: 'agent-ownerless', userId: null, config: {} },
};

const FILE_COMPONENT = { id: 'file-tool', definition: { name: 'File tool', agentEnabled: true, inputs: {} } };
const ALL_IDS = ['file-tool', ...WORKFLOWS.map(w => `subworkflow-${w.id}`)];

const { getAgentTools, getAvailableComponents, _setDepsForTests } = require('./agentTools');

_setDepsForTests({
    componentManager: () => ({ getComponents: () => [{ ...FILE_COMPONENT, definition: { ...FILE_COMPONENT.definition } }] }),
    agentStore: () => ({
        getAgentTools: async () => ALL_IDS,
        getAgentToolsWithParams: async () => [],
        getForRuntime: async (id) => AGENTS[id] || null,
    }),
    workflowStore: () => ({ getAllWorkflows: async () => WORKFLOWS.map(w => ({ ...w })) }),
    userStore: () => ({ getUser: async (id) => (USERS[id] ? { ...USERS[id] } : null) }),
    // The MCP/custom-integration tail is not under test; it only has to stay quiet.
    entitlements: () => ({ resolveEntitlements: async () => ({ degraded: true }) }),
    integrationTools: () => ({
        appendMcpTools: async () => {},
        appendCustomIntegrationTools: async () => {},
    }),
});
test.after(() => _setDepsForTests());

const idsOf = (list) => list.map(c => c.id).sort();
const toolNames = (tools) => tools.map(t => (t.function ? t.function.name : t.name)).sort();

test('the anonymous catalogue lists file components and no organisation\'s subworkflows', async () => {
    assert.deepStrictEqual(idsOf(await getAvailableComponents()), ['file-tool'],
        'an unauthenticated caller must not learn any org\'s subworkflow names, descriptions or inputs');
    assert.deepStrictEqual(idsOf(await getAvailableComponents({ userId: null })), ['file-tool']);
});

test('a signed-in user sees their own org\'s subworkflows, colleagues\' included, and no other org\'s', async () => {
    const listed = await getAvailableComponents({ userId: 'u-a1' });
    assert.deepStrictEqual(idsOf(listed), ['file-tool', 'subworkflow-wf-a1', 'subworkflow-wf-a2']);
    const a2 = listed.find(c => c.id === 'subworkflow-wf-a2');
    assert.strictEqual(a2.description, 'Secret process of A2', 'the entry itself keeps its shape');
    assert.deepStrictEqual(Object.keys(a2.inputs), ['case']);

    assert.deepStrictEqual(idsOf(await getAvailableComponents({ userId: 'u-b1' })),
        ['file-tool', 'subworkflow-wf-b1']);
});

test('a user id that no longer resolves gets no subworkflows', async () => {
    assert.deepStrictEqual(idsOf(await getAvailableComponents({ userId: 'u-deleted' })), ['file-tool']);
});

test('a user without an organisation sees only their own subworkflows', async () => {
    assert.deepStrictEqual(idsOf(await getAvailableComponents({ userId: 'u-solo' })),
        ['file-tool', 'subworkflow-wf-solo']);
});

test('an agent is offered only its owner\'s org\'s subworkflows, whatever ids it is configured with', async () => {
    const offered = toolNames(await getAgentTools('agent-b'));
    assert.ok(offered.includes('file_tool'), 'the file component is still offered');
    assert.ok(offered.includes('subworkflow_wf_b1'), 'its own org\'s subworkflow is still offered');
    for (const foreign of ['subworkflow_wf_a1', 'subworkflow_wf_a2', 'subworkflow_wf_solo']) {
        assert.ok(!offered.includes(foreign), `${foreign} belongs to another org and must not be a tool here`);
    }
});

test('an agent without an owner is offered no subworkflows', async () => {
    const offered = toolNames(await getAgentTools('agent-ownerless'));
    assert.deepStrictEqual(offered.filter(n => n.startsWith('subworkflow')), []);
    assert.ok(offered.includes('file_tool'));
});
