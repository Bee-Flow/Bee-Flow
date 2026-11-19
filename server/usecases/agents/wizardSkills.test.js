/**
 * usecases/agents/wizardSkills — the skills an agent plan proposes, from the
 * plan to stored rows.
 *
 * Pinned here:
 *   - a NEW skill gets a structured draft from the skill editor's own drafter;
 *     a reused one (by id or by name) never costs a model call;
 *   - the number of drafts per plan is bounded (AGENT_WIZARD_SKILL_DRAFTS);
 *   - a failed draft leaves the plain skill, it never blocks the plan;
 *   - static/dynamic comes from the plan, and anything unclear is static;
 *   - the draft is re-checked on the way to the store: refs, grants and
 *     audience never come from a plan;
 *   - one failed create does not drop the others, and a refused structure
 *     falls back to the plain skill.
 *
 * Run: cd server && node --test usecases/agents/wizardSkills.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const {
    draftPlannedSkills,
    plannedSkillFields,
    createPlannedSkills,
    normalisePlannedSkill,
    activationOf,
    skillDraftLimit,
    skillBrief,
    SKILL_DRAFTS_ENV,
} = require('./wizardSkills.mts');

const quietLog = () => { const warned = []; return { warned, warn: (...a) => warned.push(a.join(' ')) }; };

/** A `draft_skill` answer as the model gives it. */
const TOOL_ANSWER = (name = 'Reply drafts') => ({
    name,
    description: 'Writes a draft reply to an incoming e-mail.',
    instructions: 'Use when a new e-mail needs an answer.',
    steps: [{ text: 'Read the e-mail' }, { text: 'Write a short draft reply' }],
    rules: [{ polarity: 'never', text: 'Never send the reply yourself' }],
    examples: [{ question: 'Can we move the meeting?', good: 'A short draft proposing two times.' }],
});

const plan = (skills) => ({ name: 'E-mail assistant', description: 'Drafts replies to e-mail', skills: skills.map(normalisePlannedSkill) });

test('activation: only an explicit dynamic is dynamic', () => {
    assert.strictEqual(activationOf('dynamic'), 'dynamic');
    assert.strictEqual(activationOf('situational'), 'dynamic');
    assert.strictEqual(activationOf(true), 'dynamic');
    assert.strictEqual(activationOf('static'), 'static');
    assert.strictEqual(activationOf(undefined), 'static');
    assert.strictEqual(activationOf('sometimes'), 'static');
});

test('normalisePlannedSkill keeps only the plan fields and refuses a nameless skill', () => {
    assert.strictEqual(normalisePlannedSkill({ description: 'x' }), null);
    const s = normalisePlannedSkill({
        id: null, name: ' Reply drafts ', description: 'd', instructions: 'i', activation: 'dynamic',
        draft: { steps: [] }, knowledgeBaseIds: ['kb1'], isShared: true,
    });
    assert.deepStrictEqual(s, { id: null, name: 'Reply drafts', description: 'd', instructions: 'i', activation: 'dynamic' });
});

test('skillBrief carries the plan lines and the agent it is for', () => {
    const brief = skillBrief(normalisePlannedSkill({ name: 'Reply drafts', description: 'Writes drafts', instructions: 'For new mail' }),
        { name: 'E-mail assistant', description: 'Drafts replies' });
    assert.match(brief, /Skill: Reply drafts/);
    assert.match(brief, /What it does: Writes drafts/);
    assert.match(brief, /When to use it: For new mail/);
    assert.match(brief, /E-mail assistant: Drafts replies/);
});

test('draftPlannedSkills drafts every NEW skill with the editor drafter, never a reused one', async () => {
    const asked = [];
    const p = plan([
        { id: 'sk-known', name: 'Known skill' },
        { id: null, name: 'known by name' },
        { id: null, name: 'Reply drafts', description: 'Writes drafts', activation: 'dynamic' },
    ]);
    await draftPlannedSkills(p, {
        userId: 'u1', userOrgId: 'org1',
        existingSkills: [{ id: 'sk-known', name: 'Known skill' }, { id: 'sk-2', name: 'Known by name' }],
        ask: async (a) => { asked.push(a); return { structured: TOOL_ANSWER() }; },
        log: quietLog(),
    });
    assert.strictEqual(asked.length, 1, 'one model call, for the one new skill');
    assert.strictEqual(asked[0].source, 'skill_ai_draft');
    assert.match(asked[0].messages[1].content, /<brief>[\s\S]*Skill: Reply drafts/);
    assert.strictEqual(p.skills[0].draft, undefined);
    assert.strictEqual(p.skills[1].draft, undefined);
    const d = p.skills[2].draft;
    assert.deepStrictEqual(d.steps.map(s => s.text), ['Read the e-mail', 'Write a short draft reply']);
    assert.deepStrictEqual(d.rulesV2.map(r => [r.polarity, r.text]), [['never', 'Never send the reply yourself']]);
    assert.strictEqual(d.examplesV2.length, 1);
    assert.strictEqual(p.skills[2].activation, 'dynamic');
});

test('draftPlannedSkills drafts at most `limit` new skills; the rest stay plain', async () => {
    let calls = 0;
    const log = quietLog();
    const p = plan([1, 2, 3, 4].map(i => ({ name: `Skill ${i}` })));
    await draftPlannedSkills(p, {
        userId: 'u1', userOrgId: null, existingSkills: [], limit: 2, log,
        ask: async () => { calls++; return { structured: TOOL_ANSWER() }; },
    });
    assert.strictEqual(calls, 2);
    assert.deepStrictEqual(p.skills.map(s => Boolean(s.draft)), [true, true, false, false]);
    assert.ok(log.warned.some(w => w.includes(SKILL_DRAFTS_ENV)), 'the skipped drafts are logged by the setting name');
});

test('draftPlannedSkills: a throw, no model or an unusable answer leaves the plain skill and is logged', async () => {
    const log = quietLog();
    const p = plan([{ name: 'Throws' }, { name: 'No model' }, { name: 'Unusable' }, { name: 'Fine' }]);
    await draftPlannedSkills(p, {
        userId: 'u1', userOrgId: null, existingSkills: [], log,
        ask: async ({ messages }) => {
            const brief = messages[1].content;
            if (brief.includes('Throws')) throw new Error('provider down');
            if (brief.includes('No model')) return null;
            if (brief.includes('Unusable')) return { structured: { steps: 'not a list' } };
            return { structured: TOOL_ANSWER('Fine') };
        },
    });
    assert.deepStrictEqual(p.skills.map(s => Boolean(s.draft)), [false, false, false, true]);
    assert.strictEqual(log.warned.length, 3);
});

test('skillDraftLimit: default 5, 0 means no limit, nonsense falls back', (t) => {
    const before = process.env[SKILL_DRAFTS_ENV];
    t.after(() => { if (before === undefined) delete process.env[SKILL_DRAFTS_ENV]; else process.env[SKILL_DRAFTS_ENV] = before; });
    delete process.env[SKILL_DRAFTS_ENV];
    assert.strictEqual(skillDraftLimit(), 5);
    process.env[SKILL_DRAFTS_ENV] = '0';
    assert.strictEqual(skillDraftLimit(), Infinity);
    process.env[SKILL_DRAFTS_ENV] = '2';
    assert.strictEqual(skillDraftLimit(), 2);
});

test('plannedSkillFields: a plain planned skill is exactly the flat skill the wizard always made', () => {
    assert.deepStrictEqual(plannedSkillFields({ id: null, name: 'Flat', description: 'd', instructions: 'i' }), {
        name: 'Flat', description: 'd', instructions: 'i', icon: null, isShared: false, sharedGroups: [],
        dynamicActivation: false, workflow: '', rules: '', examples: '',
    });
});

test('plannedSkillFields: a draft becomes structure, re-checked, without refs, grants or audience', () => {
    const fields = plannedSkillFields({
        id: null, name: 'Reply drafts', description: 'One line from the person', activation: 'dynamic',
        knowledgeBaseIds: ['kb-1'], allowedAutomationIds: ['a-1'], enabledIntegrations: ['gmail'], isShared: true, sharedGroups: ['g1'],
        draft: {
            description: 'The draft line',
            instructions: 'Use when a new e-mail needs an answer.',
            steps: [{ id: 'x', text: 'Read the e-mail', refs: [{ kind: 'kb', id: 'kb-secret' }] }, { text: '   ' }],
            rulesV2: [{ polarity: 'never', text: 'Never send it yourself' }],
            examplesV2: [{ question: 'Q', good: 'A', rationale: 'R', sourceConversationId: 'c1' }],
            outputSchema: { type: 'object', properties: { subject: { type: 'string', title: 'Subject' }, 'bad key': { type: 'string' } } },
            knowledgeBaseIds: ['kb-2'],
        },
    });
    assert.strictEqual(fields.name, 'Reply drafts');
    assert.strictEqual(fields.description, 'One line from the person', 'the person\'s line wins over the draft');
    assert.strictEqual(fields.instructions, 'Use when a new e-mail needs an answer.');
    assert.strictEqual(fields.dynamicActivation, true);
    assert.strictEqual(fields.isShared, false);
    assert.deepStrictEqual(fields.sharedGroups, []);
    assert.deepStrictEqual(fields.steps.map(s => s.text), ['Read the e-mail']);
    assert.deepStrictEqual(fields.steps[0].refs, [], 'a ref is a grant at run time: never from a plan');
    assert.notStrictEqual(fields.steps[0].id, 'x', 'an id the browser sent is not kept');
    assert.deepStrictEqual(fields.rulesV2.map(r => r.text), ['Never send it yourself']);
    assert.deepStrictEqual(Object.keys(fields.examplesV2[0]).sort().filter(k => k !== 'id'), ['good', 'question', 'rationale']);
    assert.deepStrictEqual(Object.keys(fields.outputSchema.properties), ['subject']);
    for (const k of ['knowledgeBaseIds', 'allowedAutomationIds', 'enabledIntegrations', 'workflow', 'rules', 'examples']) {
        assert.ok(!(k in fields), `${k} is not written`);
    }
});

test('plannedSkillFields: a draft that does not survive the checks gives the plain skill', () => {
    const fields = plannedSkillFields({ name: 'Odd', instructions: 'plain', draft: { steps: 'nope' } });
    assert.strictEqual(fields.workflow, '');
    assert.strictEqual(fields.instructions, 'plain');
    assert.ok(!('steps' in fields));
});

function fakeStore({ existing = [], failFor = [] } = {}) {
    const created = [];
    return {
        created,
        getAvailableSkills: async () => existing,
        createSkill: async (args) => {
            if (failFor.some(f => f(args))) throw new Error('refused');
            const row = { id: `new-${created.length + 1}`, ...args };
            created.push(row);
            return row;
        },
    };
}

test('createPlannedSkills reuses by id and name, creates the rest with their structure', async () => {
    const store = fakeStore({ existing: [{ id: 'sk-1', name: 'Known' }] });
    const res = await createPlannedSkills([
        { id: 'sk-1', name: 'Something else' },
        { id: null, name: 'known' },
        { id: null, name: 'Reply drafts', activation: 'dynamic', draft: { steps: [{ text: 'Read the e-mail' }] } },
        { id: null, name: 'Reply drafts' },
    ], { orgId: 'org1', userId: 'u1', store, log: quietLog() });
    assert.deepStrictEqual(res.attachedSkillIds, ['sk-1', 'new-1']);
    assert.strictEqual(store.created.length, 1, 'the same name twice is one skill');
    assert.strictEqual(store.created[0].orgId, 'org1');
    assert.strictEqual(store.created[0].userId, 'u1');
    assert.strictEqual(store.created[0].dynamicActivation, true);
    assert.deepStrictEqual(store.created[0].steps.map(s => s.text), ['Read the e-mail']);
    assert.strictEqual(res.createdSkills.length, 1);
});

test('createPlannedSkills: a refused structure falls back to the plain skill; one failure does not drop the rest', async () => {
    const store = fakeStore({ failFor: [(a) => Array.isArray(a.steps), (a) => a.name === 'Broken'] });
    const log = quietLog();
    const res = await createPlannedSkills([
        { name: 'Broken' },
        { name: 'Structured', draft: { steps: [{ text: 'Do it' }] } },
        { name: 'Fine' },
    ], { orgId: null, userId: 'u1', store, log });
    assert.deepStrictEqual(store.created.map(c => c.name), ['Structured', 'Fine']);
    assert.strictEqual(store.created[0].workflow, '');
    assert.ok(!('steps' in store.created[0]));
    assert.deepStrictEqual(res.attachedSkillIds, ['new-1', 'new-2']);
    assert.ok(log.warned.length >= 2);
});

test('createPlannedSkills: a lookup failure still creates the new skills', async () => {
    const store = fakeStore();
    store.getAvailableSkills = async () => { throw new Error('db down'); };
    const res = await createPlannedSkills([{ name: 'New one' }], { orgId: 'org1', userId: 'u1', store, log: quietLog() });
    assert.deepStrictEqual(res.attachedSkillIds, ['new-1']);
});
