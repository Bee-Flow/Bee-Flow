/**
 * The pure skill helpers behind an AI step (handoff 5, round 3): which skill
 * leads, what the step hands on, what the skills grant under which switch,
 * and the framing that tells an agent it is a step. No module mocking: the
 * one loader takes its dependencies as arguments.
 *
 * Run: cd server && node --test core/automationRunner/aiStepSkills.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const S = require('./aiStepSkills');
const { skillIdsForStep } = require('./aiStepAgent');

const helpers = {
    skillGrantsOf: (s) => ({ kbIds: s.knowledgeBaseIds || [], automationIds: s.allowedAutomationIds || [], tableRefs: [] }),
    isDynamicSkill: (s) => s.dynamicActivation === true || !!s.automationId,
    sanitizeEnabledIntegrations: (l) => (Array.isArray(l) ? l : []),
};

function skill(id, over = {}) {
    return { id, name: id, knowledgeBaseIds: [], allowedAutomationIds: [], enabledIntegrations: [], outputSchema: null, ...over };
}

test('the agent skills a step switched off drop out; the step skills stay first', () => {
    const ids = skillIdsForStep(
        { skillIds: ['own', 'shared'], disabledAgentSkillIds: ['a1'] },
        { config: { attachedSkillIds: ['a1', 'a2', 'shared'] } },
    );
    assert.deepStrictEqual(ids, { attachedSkillIds: ['own', 'shared'], sessionSkillIds: ['a2'] });
});

test('switching off one of the step\'s OWN skills via the agent list changes nothing', () => {
    const ids = skillIdsForStep({ skillIds: ['own'], disabledAgentSkillIds: ['own'] }, { config: { attachedSkillIds: [] } });
    assert.deepStrictEqual(ids.attachedSkillIds, ['own']);
});

test('the sanitiser keeps order, drops junk and duplicates', () => {
    assert.deepStrictEqual(S.sanitizeDisabledAgentSkillIds([' a ', 'a', 7, '', 'b']), ['a', 'b']);
    assert.deepStrictEqual(S.sanitizeDisabledAgentSkillIds('a'), []);
});

test('skills come back in run order, unreadable ones left out', () => {
    const rows = [skill('b'), skill('a')];
    assert.deepStrictEqual(S.orderSkills(rows, ['a', 'x', 'b']).map((s) => s.id), ['a', 'b']);
});

test('a skill schema without fields is no contract', () => {
    assert.strictEqual(S.skillOutputSchema(skill('a')), null);
    assert.strictEqual(S.skillOutputSchema(skill('a', { outputSchema: { type: 'object', properties: {} } })), null);
    assert.deepStrictEqual(
        S.skillOutputSchema(skill('a', { outputSchema: { type: 'object', properties: { n: { type: 'number' } }, required: ['n', 'ghost'] } })),
        { type: 'object', properties: { n: { type: 'number' } }, required: ['n'] },
    );
});

test('the step\'s own schema wins; then the skill, widened by fields read downstream; then inference', () => {
    const own = { type: 'object', properties: { a: { type: 'string' } } };
    const sk = { type: 'object', properties: { amount: { type: 'number' } } };
    assert.deepStrictEqual(S.effectiveOutputSchema({ stepSchema: own, skillSchema: sk, inferredFields: ['x'] }), { schema: own, source: 'step', declared: true });
    assert.deepStrictEqual(S.effectiveOutputSchema({ skillSchema: sk, inferredFields: ['vendor', 'amount'] }), {
        schema: { type: 'object', properties: { amount: { type: 'number' }, vendor: { type: 'string' } } },
        source: 'skill', declared: true,
    });
    assert.deepStrictEqual(S.effectiveOutputSchema({ inferredFields: ['x'] }), { schema: { x: 'string' }, source: 'inferred', declared: false });
    assert.deepStrictEqual(S.effectiveOutputSchema({}), { schema: null, source: null, declared: false });
});

test('output fields read as the editor lists them', () => {
    const fields = S.outputFieldsOf({
        type: 'object',
        properties: {
            total: { type: 'integer', title: 'Total' },
            due: { type: 'string', format: 'date' },
            ok: { type: 'boolean' },
            odd: { type: 'weird' },
        },
    });
    assert.deepStrictEqual(fields, [
        { key: 'total', type: 'number', title: 'Total' },
        { key: 'due', type: 'datetime', title: null },
        { key: 'ok', type: 'boolean', title: null },
        { key: 'odd', type: 'string', title: null },
    ]);
    assert.deepStrictEqual(S.outputFieldsOf(null), []);
});

test('grants come from static skills only, merged and deduped', () => {
    const g = S.skillGrantsForStep([
        skill('a', { knowledgeBaseIds: ['kb1'], enabledIntegrations: ['drive'], allowedAutomationIds: ['r1'] }),
        skill('b', { knowledgeBaseIds: ['kb1', 'kb2'], enabledIntegrations: ['drive', 'gmail'] }),
        skill('c', { dynamicActivation: true, knowledgeBaseIds: ['kb_dyn'] }),
    ], helpers);
    assert.deepStrictEqual(g, { kbIds: ['kb1', 'kb2'], apps: ['drive', 'gmail'], automationIds: ['r1'] });
});

test('every grant hangs on its own switch', () => {
    const g = { kbIds: ['kb1'], apps: ['drive'], automationIds: ['r1'] };
    assert.deepStrictEqual(S.grantsUnderPermissions(g, {}), { kbIds: [], apps: [], automationIds: [] });
    assert.deepStrictEqual(S.grantsUnderPermissions(g, { useKnowledge: true }), { kbIds: ['kb1'], apps: [], automationIds: [] });
    assert.deepStrictEqual(S.grantsUnderPermissions(g, { useTools: true, startAutomations: true }), { kbIds: [], apps: ['drive'], automationIds: ['r1'] });
    assert.deepStrictEqual(S.grantsUnderPermissions(g, { useTools: 'yes' }).apps, [], 'only a real true opens a switch');
});

test('skill routines join a CURATED agent only, as a copy', () => {
    const curated = { tools: { automations: { r1: { confirm: 'direct' } } } };
    const out = S.configWithSkillAutomations(curated, ['r2', 'r1']);
    assert.deepStrictEqual(out.tools.automations, { r1: { confirm: 'direct' }, r2: {} });
    assert.deepStrictEqual(curated.tools.automations, { r1: { confirm: 'direct' } }, 'not mutated');
    const uncurated = { tools: {} };
    assert.strictEqual(S.configWithSkillAutomations(uncurated, ['r2']), uncurated, 'an uncurated agent already has every routine');
    const unreadable = { tools: { automations: 'all' } };
    assert.strictEqual(S.configWithSkillAutomations(unreadable, ['r2']), unreadable, 'an unreadable choice is not widened');
    assert.strictEqual(S.configWithSkillAutomations(curated, []), curated);
});

test('the framing forbids questions and points at the attention field when there is one', () => {
    const withField = S.unattendedStepFraming({ type: 'object', properties: { answer: {}, pointsOfAttention: {} } });
    assert.match(withField, /never ask the user anything back/);
    assert.match(withField, /never wait for a confirmation/);
    assert.match(withField, /"pointsOfAttention" field/);
    assert.match(S.unattendedStepFraming({ aandachtspunten: 'string' }), /"aandachtspunten" field/);
    assert.match(S.unattendedStepFraming(null), /say what you were unsure about in your answer/);
    assert.doesNotMatch(withField, /[–—]/, 'no dashes as punctuation');
});

test('loadStepSkillContext loads once, in run order, and derives lead, schema and grants', async () => {
    const calls = [];
    const injection = {
        ...helpers,
        async loadSkillsForIds(args) {
            calls.push(args);
            return {
                mergedIds: ['own', 'a2'],
                skills: [
                    skill('a2', { knowledgeBaseIds: ['kb2'] }),
                    skill('own', { outputSchema: { type: 'object', properties: { total: { type: 'number' } } } }),
                ],
            };
        },
    };
    const ctx = await S.loadStepSkillContext({
        step: { id: 's', skillIds: ['own'], disabledAgentSkillIds: ['a1'] },
        ctx: { orgId: 'org1', userId: 'u1' },
        binding: { config: { attachedSkillIds: ['a1', 'a2'] } },
        deps: { skillInjection: injection },
    });
    assert.deepStrictEqual(calls, [{ attachedSkillIds: ['own'], sessionSkillIds: ['a2'], orgId: 'org1', userId: 'u1' }]);
    assert.strictEqual(ctx.loaded, true);
    assert.deepStrictEqual(ctx.skills.map((s) => s.id), ['own', 'a2']);
    assert.strictEqual(ctx.leading.id, 'own');
    assert.deepStrictEqual(ctx.leadingSchema, { type: 'object', properties: { total: { type: 'number' } } });
    assert.deepStrictEqual(ctx.grants.kbIds, ['kb2']);
});

test('no skills, no organisation, or a failed read all leave the step without skills', async () => {
    const boom = { ...helpers, async loadSkillsForIds() { throw new Error('db down'); } };
    const warnings = [];
    const log = { warn: (m) => warnings.push(m) };
    const none = await S.loadStepSkillContext({ step: { id: 's' }, ctx: { orgId: 'o' }, deps: { skillInjection: boom, log } });
    assert.strictEqual(none.loaded, false);
    const noOrg = await S.loadStepSkillContext({ step: { id: 's', skillIds: ['x'] }, ctx: {}, deps: { skillInjection: boom, log } });
    assert.strictEqual(noOrg.loaded, false);
    const failed = await S.loadStepSkillContext({ step: { id: 's', skillIds: ['x'] }, ctx: { orgId: 'o' }, deps: { skillInjection: boom, log } });
    assert.strictEqual(failed.loaded, false);
    assert.deepStrictEqual(failed.grants, { kbIds: [], apps: [], automationIds: [] });
    assert.match(warnings[0], /db down/);
});
