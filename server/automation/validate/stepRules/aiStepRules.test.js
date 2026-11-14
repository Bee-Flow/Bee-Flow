// @typecheck
'use strict';

/**
 * checkAiStep, finding by finding: for each ai_step shape (and what the rest of
 * the draft reads from it), the exact findings — severity, code, path, message
 * and hint, in order. The builder model reads them, so a refactor that changes
 * one fails here.
 *
 * Run: node --test automation/validate/stepRules/aiStepRules.test.js
 */
const test = require('node:test');
const assert = require('node:assert');
const { checkAiStep } = require('./aiStepRules');

const schema = { type: 'object', properties: { total: { type: 'number' }, lines: { type: 'array', items: { type: 'object', properties: { sku: { type: 'string' } } } } } };
/**
 * @param {string[]} all
 * @param {string[]} [viaLoop]
 */
const reads = (all, viaLoop = []) => ({ reads: { all, viaLoop } });

/**
 * [case, step fields, what the draft around it says, exact findings]
 * @type {Array<[string, Record<string, any>, { reads?: { all: string[], viaLoop: string[] }, inferred?: any, agents?: string[], refIds?: string[] }, string[][]]>}
 */
const CASES = [
    ['clean', {}, {},
        []],
    ['no prompt', { prompt: undefined }, {},
        [
            ["E","ai_step.prompt_missing","steps[2].prompt","Step self: ai_step requires `prompt`.","Provide a non-empty prompt string."],
        ]],
    ['prompt not text', { prompt: 5 }, {},
        [
            ["E","ai_step.prompt_missing","steps[2].prompt","Step self: ai_step requires `prompt`.","Provide a non-empty prompt string."],
        ]],
    ['declared schema', { outputSchema: { properties: { a: {} } } }, reads(['a']),
        []],
    ['declared bare schema', { outputSchema: { a: {} } }, reads(['a']),
        []],
    ['inferred, skills', { skillIds: ['sk1'] }, { inferred: { fields: ['total', 'lines'], schema }, ...reads(['total', 'lines']) },
        [
            ["W","ai_step.output_schema_from_skill","steps[2].outputSchema","Step self: later steps read `total`, `lines` from this step, which has no outputSchema of its own. It answers in the output fields of its leading skill; a field the skill does not declare is added as the runner infers it from those reads: {total: number, lines: [{sku: string}]}.","Check the leading skill's output fields, or give the step its own schema: outputSchema: {\"type\":\"object\",\"properties\":{\"total\":{\"type\":\"number\"},\"lines\":{\"type\":\"array\",\"items\":{\"type\":\"object\",\"properties\":{\"sku\":{\"type\":\"string\"}}}}}}. Numbers as {\"type\":\"number\"}."],
        ]],
    ['inferred', {}, { inferred: { fields: ['total'], schema, textField: 'text' }, ...reads(['total']) },
        [
            ["W","ai_step.output_schema_inferred","steps[2].outputSchema","Step self: later steps read `total` from this step and it declares no outputSchema — the runner infers {total: number, lines: [{sku: string}]} from those references and wraps a prose answer under `text`.","An explicit schema gives tighter, typed output: outputSchema: {\"type\":\"object\",\"properties\":{\"total\":{\"type\":\"number\"},\"lines\":{\"type\":\"array\",\"items\":{\"type\":\"object\",\"properties\":{\"sku\":{\"type\":\"string\"}}}}}}. Numbers as {\"type\":\"number\"}."],
        ]],
    ['inferred, no text field', {}, { inferred: { fields: ['total'], schema }, ...reads(['total']) },
        [
            ["W","ai_step.output_schema_inferred","steps[2].outputSchema","Step self: later steps read `total` from this step and it declares no outputSchema — the runner infers {total: number, lines: [{sku: string}]} from those references.","An explicit schema gives tighter, typed output: outputSchema: {\"type\":\"object\",\"properties\":{\"total\":{\"type\":\"number\"},\"lines\":{\"type\":\"array\",\"items\":{\"type\":\"object\",\"properties\":{\"sku\":{\"type\":\"string\"}}}}}}. Numbers as {\"type\":\"number\"}."],
        ]],
    ['inferred long schema', {}, { inferred: { fields: ['a'], schema: { type: 'object', properties: Object.fromEntries(Array.from({ length: 40 }, (_, i) => ['field_with_a_long_name_' + i, { type: 'string' }])) } }, ...reads(['a']) },
        [
            ["W","ai_step.output_schema_inferred","steps[2].outputSchema","Step self: later steps read `a` from this step and it declares no outputSchema — the runner infers {field_with_a_long_name_0: string, field_with_a_long_name_1: string, field_with_a_long_name_2: string, field_with_a_long_name_3: string, field_with_a_long_name_4: string, field_with_a_long_name_5: string, field_with_a_long_name_6: string, field_with_a_long_name_7: string, field_with_a_long_name_8: string, field_with_a_long_name_9: string, field_with_a_long_name_10: string, field_with_a_long_name_… from those references.","An explicit schema gives tighter, typed output: outputSchema: {\"type\":\"object\",\"properties\":{\"field_with_a_long_name_0\":{\"type\":\"string\"},\"field_with_a_long_name_1\":{\"type\":\"string\"},\"field_with_a_long_name_2\":{\"type\":\"string\"}}}. Numbers as {\"type\":\"number\"}."],
        ]],
    ['odd keys in schema', {}, { inferred: { fields: ['a b'], schema: { type: 'object', properties: { 'a b': { type: 'array' }, ok: { type: 'integer' } } } }, ...reads(['a b']) },
        [
            ["W","ai_step.output_schema_inferred","steps[2].outputSchema","Step self: later steps read `a b` from this step and it declares no outputSchema — the runner infers {\"a b\": [], ok: integer} from those references.","An explicit schema gives tighter, typed output: outputSchema: {\"type\":\"object\",\"properties\":{\"a b\":{\"type\":\"array\"},\"ok\":{\"type\":\"integer\"}}}. Numbers as {\"type\":\"number\"}."],
        ]],
    ['nothing inferred, reads', {}, reads(['x', 'y']),
        [
            ["E","ai_step.output_schema_missing","steps[2].outputSchema","Step self: later steps read `x`, `y` from this step, but it declares no outputSchema — without one it answers free-form text and every one of those references resolves to nothing.","Give it those fields, e.g. outputSchema: {\"type\":\"object\",\"properties\":{\"x\":{\"type\":\"string\"},\"y\":{\"type\":\"string\"}}}. Numbers as {\"type\":\"number\"}."],
        ]],
    ['per item, direct reads', { forEach: { overRef: 'steps.s.output.items' } }, { inferred: { fields: ['a'], schema }, ...reads(['a', 'b'], ['b']) },
        [
            ["W","ai_step.output_schema_inferred","steps[2].outputSchema","Step self: later steps read `a` from this step and it declares no outputSchema — the runner infers {total: number, lines: [{sku: string}]} from those references.","An explicit schema gives tighter, typed output: outputSchema: {\"type\":\"object\",\"properties\":{\"total\":{\"type\":\"number\"},\"lines\":{\"type\":\"array\",\"items\":{\"type\":\"object\",\"properties\":{\"sku\":{\"type\":\"string\"}}}}}}. Numbers as {\"type\":\"number\"}."],
            ["E","ai_step.output_schema_missing","steps[2].outputSchema","Step self: later steps read `a` straight off this step, but it runs once per item — its output is the list of answers, so those references resolve to nothing.","Read every answer's a as steps.self.output.results[*].output.a, or run the next step once per answer over steps.self.output.results and read loop.<item>.output.a."],
        ]],
    ['per item, via loop', { forEach: { overRef: 'steps.s.output.items' } }, reads(['a'], ['a']),
        []],
    ['per item, blank overRef', { forEach: { overRef: '' } }, reads(['a']),
        [
            ["E","ai_step.output_schema_missing","steps[2].outputSchema","Step self: later steps read `a` from this step, but it declares no outputSchema — without one it answers free-form text and every one of those references resolves to nothing.","Give it those fields, e.g. outputSchema: {\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}. Numbers as {\"type\":\"number\"}."],
        ]],
    ['tools allowlist empty', { allowTools: true, tools: [] }, {},
        [
            ["W","ai_step.tools_allowlist_empty","steps[2].tools","Step self: allowTools is on but the tool allowlist is empty — this step runs with NO tools.","Pick tools in the step's Tools section, or turn \"Allow tools\" off."],
        ]],
    ['tools allowlist', { allowTools: true, tools: ['a'] }, {},
        []],
    ['kb ids', { knowledgeBaseIds: 'x' }, {},
        [
            ["E","ai_step.knowledge_base_ids_invalid","steps[2].knowledgeBaseIds","Step self: knowledgeBaseIds must be an array of knowledge-base id strings.","Pick knowledge bases from the step's Knowledge bases picker, or remove the field."],
        ]],
    ['kb ids numbers', { knowledgeBaseIds: [1] }, {},
        [
            ["E","ai_step.knowledge_base_ids_invalid","steps[2].knowledgeBaseIds","Step self: knowledgeBaseIds must be an array of knowledge-base id strings.","Pick knowledge bases from the step's Knowledge bases picker, or remove the field."],
        ]],
    ['kb ids ok', { knowledgeBaseIds: ['kb1'] }, {},
        []],
    ['kb ids null', { knowledgeBaseIds: null }, {},
        []],
    ['agent id number', { agentId: 5 }, {},
        [
            ["E","ai_step.agent_id_invalid","steps[2].agentId","Step self: agentId must be the id of an agent, as a string.","Pick an agent in the step, or remove the field to let the step answer on its own prompt."],
        ]],
    ['agent unknown', { agentId: 'agt_x', agentPermissions: {} }, { agents: ['agt_y'] },
        [
            ["E","ai_step.agent_unavailable","steps[2].agentId","Step self: there is no agent \"agt_x\" this automation can use.","Pick an agent in the step. The same answer is given whether the agent was deleted, was never published, belongs to another workspace, or is not shared with this automation's owner — deliberately, so an automation cannot be used to find out which agents exist elsewhere."],
        ]],
    ['agent known trimmed', { agentId: ' agt_y ', agentPermissions: {} }, { agents: ['agt_y'] },
        []],
    ['agent no catalog', { agentId: 'agt_x', agentPermissions: {} }, {},
        []],
    ['agent blank', { agentId: '  ' }, { agents: [] },
        []],
    ['skills not list', { skillIds: 'x' }, {},
        [
            ["E","ai_step.skill_ids_invalid","steps[2].skillIds","Step self: skillIds must be an array of skill id strings.","Pick skills in the step, or remove the field."],
        ]],
    ['skills numbers', { skillIds: [1] }, {},
        [
            ["E","ai_step.skill_ids_invalid","steps[2].skillIds","Step self: skillIds must be an array of skill id strings.","Pick skills in the step, or remove the field."],
        ]],
    ['skills dupe one', { skillIds: ['a', 'a', ''] }, {},
        [
            ["W","ai_step.skill_ids_ignored","steps[2].skillIds","Step self: skill \"a\" is listed more than once — the repeat is ignored.","Remove the duplicate; the first entry is the leading skill and decides the order."],
        ]],
    ['skills dupes', { skillIds: ['a', 'a', 'b', 'b', 'b'] }, {},
        [
            ["W","ai_step.skill_ids_ignored","steps[2].skillIds","Step self: skills \"a\", \"b\" are listed more than once — the repeat is ignored.","Remove the duplicate; the first entry is the leading skill and decides the order."],
        ]],
    ['skills too many', { skillIds: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] }, {},
        [
            ["W","ai_step.skill_ids_ignored","steps[2].skillIds","Step self: 7 skills are attached but only the first 5 are used — \"f\", \"g\" never reach the model.","Keep at most 5, most important first."],
        ]],
    ['skills both', { skillIds: ['a', 'b', 'c', 'd', 'e', 'f', 'f'] }, {},
        [
            ["W","ai_step.skill_ids_ignored","steps[2].skillIds","Step self: skill \"f\" is listed more than once — the repeat is ignored.","Remove the duplicate; the first entry is the leading skill and decides the order."],
            ["W","ai_step.skill_ids_ignored","steps[2].skillIds","Step self: 6 skills are attached but only the first 5 are used — \"f\" never reach the model.","Keep at most 5, most important first."],
        ]],
    ['disabled not list', { disabledAgentSkillIds: 'x' }, {},
        [
            ["E","ai_step.disabled_agent_skill_ids_invalid","steps[2].disabledAgentSkillIds","Step self: disabledAgentSkillIds must be a list of skill id strings.","Switch the agent's skills on or off in the step, or remove the field."],
        ]],
    ['disabled no agent', { disabledAgentSkillIds: ['s'] }, {},
        [
            ["W","ai_step.disabled_agent_skill_ids_orphan","steps[2].disabledAgentSkillIds","Step self: this step switches agent skills off but names no agent, so nothing reads it.","Pick an agent for the step, or remove disabledAgentSkillIds."],
        ]],
    ['disabled with agent', { agentId: 'agt', agentPermissions: {}, disabledAgentSkillIds: ['s'] }, {},
        []],
    ['disabled empty', { disabledAgentSkillIds: [] }, {},
        []],
    ['perms not object', { agentPermissions: 'x' }, {},
        [
            ["E","ai_step.agent_permissions_invalid","steps[2].agentPermissions","Step self: agentPermissions must be an object of startAutomations/useKnowledge/useTools booleans.","Use the step's permission toggles, or remove the field — leaving it out means the agent gets none of them."],
        ]],
    ['perms bad value', { agentId: 'agt', agentPermissions: { useTools: 'yes', useKnowledge: 1, startAutomations: true } }, {},
        [
            ["E","ai_step.agent_permissions_invalid","steps[2].agentPermissions.useKnowledge","Step self: agentPermissions.useKnowledge must be true or false, not 1.","A value nothing can read is not a yes — it is treated as off. Set it to true or false."],
            ["E","ai_step.agent_permissions_invalid","steps[2].agentPermissions.useTools","Step self: agentPermissions.useTools must be true or false, not \"yes\".","A value nothing can read is not a yes — it is treated as off. Set it to true or false."],
        ]],
    ['perms unknown keys', { agentId: 'agt', agentPermissions: { foo: true, bar: 1 } }, {},
        [
            ["W","ai_step.agent_permissions_unknown","steps[2].agentPermissions","Step self: \"foo\", \"bar\" is not a permission this step grants — it is stored and does nothing.","The permissions are startAutomations, useKnowledge, useTools. Remove the rest so the step does not read as more configured than it is."],
        ]],
    ['perms orphan', { agentPermissions: { useTools: true } }, {},
        [
            ["W","ai_step.agent_permissions_orphan","steps[2].agentPermissions","Step self: this step sets agent permissions but names no agent, so nothing reads them.","Pick an agent for the step, or remove agentPermissions."],
        ]],
    ['perms with skills', { skillIds: ['s'], agentPermissions: { useTools: true } }, {},
        []],
    ['perms missing', { agentId: 'agt' }, {},
        [
            ["W","ai_step.agent_permissions_missing","steps[2].agentPermissions","Step self: no agent permissions are set, so the agent answers from its role alone — no knowledge bases, no tools, and it cannot start other automations.","That is the deliberate default. Turn on only what this step needs in the step's permissions."],
        ]],
    ['perms null with agent', { agentId: 'agt', agentPermissions: null }, {},
        [
            ["W","ai_step.agent_permissions_missing","steps[2].agentPermissions","Step self: no agent permissions are set, so the agent answers from its role alone — no knowledge bases, no tools, and it cannot start other automations.","That is the deliberate default. Turn on only what this step needs in the step's permissions."],
        ]],
    ['prompt refs', { prompt: 'Hi {{steps.ghost.output.x}} {{steps.self.output}} {{steps.s1.output.a}} {{trigger.x}} {{vars.v}} {{secrets.k}} {{loop.i}} {{mine}} {{mine.deep}} {{weird.x}} {{steps}}', inputs: { mine: { kind: 'literal', value: 1 } } }, { refIds: ['trg', 's1'] },
        [
            ["W","ref.prompt_unknown_step","steps[2].prompt","Step self: prompt references non-existent step \"ghost\" — the model will receive the literal {{…}} text.","Fix the id or remove the placeholder. Available: s1."],
            ["W","ref.prompt_unknown_root","steps[2].prompt","Step self: prompt placeholder \"{{weird.x}}\" has no matching input or data root — the model receives it verbatim.","Use trigger/steps/vars/loop paths, one of this step's own input names, or plain text."],
        ]],
    ['prompt refs no steps', { prompt: '{{steps.ghost.output}}' }, { refIds: ['trg'] },
        [
            ["W","ref.prompt_unknown_step","steps[2].prompt","Step self: prompt references non-existent step \"ghost\" — the model will receive the literal {{…}} text.","Fix the id or remove the placeholder. Available: (none)."],
        ]],
    ['not ai_step', { type: 'wait', prompt: undefined, agentId: 5 }, {},
        []],
];

test('checkAiStep reports exactly these findings, in this order', () => {
    for (const [name, over, around, want] of CASES) {
        /** @type {string[][]} */
        const found = [];
        const ctx = {
            pushE: (/** @type {any} */ f) => found.push(['E', f.code, f.path, f.message, f.hint]),
            pushW: (/** @type {any} */ f) => found.push(['W', f.code, f.path, f.message, f.hint]),
            trigger: { id: 'trg' },
            refIds: new Set(around.refIds || ['trg']),
            availableAgents: around.agents ? new Set(around.agents) : undefined,
            fieldsReadFromStep: () => around.reads || { all: [], viaLoop: [] },
            inferredOutputOf: () => around.inferred || { fields: [], schema: null },
        };
        checkAiStep(ctx, { id: 'self', type: 'ai_step', prompt: 'Summarise', ...over }, 'steps[2]');
        assert.deepStrictEqual(found, want, name);
    }
});
