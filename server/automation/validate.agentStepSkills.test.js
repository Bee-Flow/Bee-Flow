/**
 * The handoff-5 additions to an AI step's definition, on both ends that
 * write or check it: `disabledAgentSkillIds` (the agent's skills a step
 * switches off), permissions on a step that applies skills without an agent,
 * and a step whose output contract comes from its leading skill.
 *
 * Run: cd server && node --test automation/validate.agentStepSkills.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { validateDefinition } = require('./validate');
const { applyAddAi } = require('./builderTools/stepBuilders/aiStep');
const { applyUpdateStep } = require('./builderTools/stepEditing');

const TRIGGER = { id: 'trg', kind: 'manual' };
const OFF = { startAutomations: false, useKnowledge: false, useTools: false };

function def(step, extraSteps = [], extraEdges = []) {
    return {
        trigger: TRIGGER,
        steps: [{ id: 's1', type: 'ai_step', prompt: 'do the thing', ...step }, ...extraSteps],
        edges: [{ from: 'trg', to: 's1' }, ...extraEdges],
    };
}
const codes = (d, kind) => (validateDefinition(d, { stage: 'activate' })[kind] || []).map((e) => e.code);

function draft() {
    return { trigger: TRIGGER, steps: [], edges: [] };
}

test('disabledAgentSkillIds on an agent step validates cleanly', () => {
    const d = def({ agentId: 'agt_1', skillIds: [], agentPermissions: OFF, disabledAgentSkillIds: ['sk_a'] });
    assert.deepStrictEqual(codes(d, 'errors'), []);
    assert.deepStrictEqual(codes(d, 'warnings'), []);
});

test('a disabledAgentSkillIds that is not a list of ids is refused', () => {
    for (const bad of ['sk_a', [1], { a: 1 }]) {
        assert.ok(codes(def({ agentId: 'agt_1', agentPermissions: OFF, disabledAgentSkillIds: bad }), 'errors')
            .includes('ai_step.disabled_agent_skill_ids_invalid'), JSON.stringify(bad));
    }
});

test('disabledAgentSkillIds without an agent says it does nothing', () => {
    assert.ok(codes(def({ disabledAgentSkillIds: ['sk_a'] }), 'warnings').includes('ai_step.disabled_agent_skill_ids_orphan'));
});

test('permissions on a skill step without an agent are read, so not an orphan', () => {
    const d = def({ skillIds: ['sk_a'], agentPermissions: { ...OFF, startAutomations: true } });
    assert.ok(!codes(d, 'warnings').includes('ai_step.agent_permissions_orphan'));
    const bare = def({ agentPermissions: { ...OFF, startAutomations: true } });
    assert.ok(codes(bare, 'warnings').includes('ai_step.agent_permissions_orphan'), 'without skills it still is');
});

test('a fan-out reading fields off a skill step warns instead of blocking activation', () => {
    const fanOut = (aiExtra) => ({
        trigger: TRIGGER,
        steps: [
            { id: 'a1', type: 'integration_action', tool: 'nextcloud_list_files', inputs: { path: { kind: 'literal', value: '/Invoices' } } },
            { id: 'ai1', type: 'ai_step', prompt: 'extract', forEach: { overRef: 'steps.a1.output.items', itemVar: 'f' }, ...aiExtra },
            {
                id: 'a2', type: 'integration_action', tool: 'nextcloud_tables_create_row',
                forEach: { overRef: 'steps.ai1.output.results', itemVar: 'e' },
                inputs: { tableId: { kind: 'literal', value: 4 }, values: { Totaal: { kind: 'ref', path: 'loop.e.output.totaal' } } },
            },
        ],
        edges: [{ from: 'trg', to: 'a1' }, { from: 'a1', to: 'ai1' }, { from: 'ai1', to: 'a2' }],
    });
    const errs = (d) => (validateDefinition(d, {}).errors || []).map((e) => e.code);
    const warns = (d) => (validateDefinition(d, {}).warnings || []).map((e) => e.code);
    assert.ok(errs(fanOut({})).includes('ai_step.output_schema_missing'), 'precondition: the plain step is refused');
    const withSkill = fanOut({ skillIds: ['sk_quote'] });
    assert.ok(!errs(withSkill).includes('ai_step.output_schema_missing'));
    assert.ok(warns(withSkill).includes('ai_step.output_schema_from_skill'));
});

test('the builder writes disabledAgentSkillIds only on an agent step with something in it', () => {
    const { added } = applyAddAi(draft(), { prompt: 'p', agentId: 'agt_1', disabledAgentSkillIds: ['a', 'a', 3, 'b'] });
    assert.deepStrictEqual(added.disabledAgentSkillIds, ['a', 'b']);
    const plain = applyAddAi(draft(), { prompt: 'p', disabledAgentSkillIds: ['a'] }).added;
    assert.ok(!('disabledAgentSkillIds' in plain));
    const empty = applyAddAi(draft(), { prompt: 'p', agentId: 'agt_1', disabledAgentSkillIds: [] }).added;
    assert.ok(!('disabledAgentSkillIds' in empty));
});

test('the builder keeps permissions on a skill step without an agent, and still refuses them on a bare step', () => {
    const { added } = applyAddAi(draft(), { prompt: 'p', skillIds: ['sk_a'], agentPermissions: { startAutomations: true } });
    assert.deepStrictEqual(added.agentPermissions, { startAutomations: true, useKnowledge: false, useTools: false });
    const bare = applyAddAi(draft(), { prompt: 'p', agentPermissions: { startAutomations: true } });
    assert.match(bare.error, /names no agent/);
});

test('a patch replaces disabledAgentSkillIds wholesale, and an empty list removes the key', () => {
    const d = draft();
    const { added } = applyAddAi(d, { prompt: 'p', agentId: 'agt_1', agentPermissions: OFF });
    d.steps.push(added);
    const r1 = applyUpdateStep(d, { stepId: added.id, patch: { disabledAgentSkillIds: ['x', 'y'] } });
    assert.ok(!r1.error, r1.error);
    assert.deepStrictEqual(r1.updated.disabledAgentSkillIds, ['x', 'y']);
    const r2 = applyUpdateStep(d, { stepId: added.id, patch: { disabledAgentSkillIds: [] } });
    assert.ok(!('disabledAgentSkillIds' in r2.updated));
});
