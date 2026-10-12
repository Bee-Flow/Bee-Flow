/**
 * skillInjection — the S1 additions (Bee Flow Builder redesign, Sep 2026):
 *
 *   - a MIGRATED skill (text + parsed structure) renders BYTE-IDENTICALLY to
 *     the same skill before the migration. This is the whole compatibility
 *     claim of S1: the migration writes structure next to the text and never
 *     touches the text, so no prompt changes under anyone's feet;
 *   - a row that somehow has structure but no text still renders (defensive);
 *   - `resolveSkillGrants` — the adapter A1b / toolStackAssembly consumes:
 *     { automationIds, tableRefs, kbIds } for the ACTIVE skills;
 *   - `resolveSkillKbAllowlist`, the KB-only view next to
 *     `resolveSkillAppAllowlist`;
 *   - both the static path and `activate_skill` record an activation
 *     ("Laatste keer"), fire-and-forget.
 *
 * DB-free: stores/skillStore and stores/skillActivations are stubbed via
 * require.cache BEFORE skillInjection is required (the pattern of
 * skillInjection.test.js) — and so are the automation store and runner.
 *
 * ── WHY THE AUTOMATION STUBS ARE NOT OPTIONAL ───────────────────────
 * `executeActivateSkill` requires `stores/automationStore` and
 * `core/automationRunner` LAZILY but UNCONDITIONALLY (skillInjection.js, in
 * the block above the per-skill render), for every activation — including
 * the ones here, whose skills link no automation at all. That require chain
 * drags in the notification store and the config store, whose LISTEN/NOTIFY
 * reconnect loop starts at module load and whose pg client per attempt is
 * not unref'd. The event loop then never empties: this file ran its eleven
 * tests, printed a wall of `ECONNREFUSED 127.0.0.1:5432`, and hung until it
 * was killed. Stubbing the two ends that, and the guard in the last test
 * fails the moment one of them is back in the process.
 *
 * This file terminates ON ITS OWN — no `--test-force-exit`.
 *
 * Run: cd server && node --test core/tools/skillInjection.structured.test.js
 */

const { test, beforeEach } = require('node:test');
const assert = require('node:assert');

process.env.NODE_ENV = 'test';

let mockSkills = [];
const activations = [];

function mock(request, exports) {
    const p = require.resolve(request);
    require.cache[p] = { id: p, filename: p, loaded: true, exports };
}

mock('../../stores/skillStore', {
    getSkillsByIds: async (ids) => mockSkills.filter(s => ids.includes(s.id)),
});
mock('../../stores/skillActivations', {
    recordActivations: async (p) => { activations.push(p); return p.skillIds.length; },
});
// See the header: `executeActivateSkill` requires both of these on every
// activation, and the real ones open a database.
mock('../../stores/automationStore', {
    getAutomation: async () => { throw new Error('no skill here links an automation'); },
});
mock('../automationRunner', {
    executeAutomation: async () => { throw new Error('no skill here links an automation'); },
});

const {
    buildSkillInjection,
    executeActivateSkill,
    resolveSkillGrants,
    resolveSkillKbAllowlist,
    skillGrantsOf,
    isDynamicSkill,
} = require('./skillInjection');

const {
    parseWorkflowToSteps,
    parseRulesToRulesV2,
    parseExamplesToExamplesV2,
} = require('../skills/skillStructure');

/** A skill exactly as it looked BEFORE S1: text columns, no structure. */
const legacySkill = (over = {}) => ({
    id: 'sk1', name: 'Quote helper', description: 'Helps with quotes', instructions: 'Be precise.',
    workflow: '1. Read the request\n2. Look up the price\n3. Write the quote',
    rules: '- Never guess a price\n- Always name the source',
    examples: 'Input: What does a X cost?\nOutput: EUR 120 excl. VAT.',
    icon: '⚡', dynamicActivation: false, automationId: null, enabledIntegrations: [],
    ...over,
});

/** The same row AFTER migrations/skills-structured-fields.js has visited it. */
const migratedSkill = (over = {}) => {
    const s = legacySkill(over);
    return {
        ...s,
        steps: parseWorkflowToSteps(s.workflow),
        rulesV2: parseRulesToRulesV2(s.rules),
        examplesV2: parseExamplesToExamplesV2(s.examples),
        outputSchema: null, knowledgeBaseIds: [], allowedAutomationIds: [], version: 1,
    };
};

const opts = { attachedSkillIds: ['sk1'], orgId: 'org1', userId: 'u1' };

beforeEach(() => { mockSkills = []; activations.length = 0; });

// ── byte-identical rendering ─────────────────────────────────────────
test('a migrated skill renders byte-identically to the same skill before the migration', async () => {
    mockSkills = [legacySkill()];
    const before = await buildSkillInjection(opts);
    mockSkills = [migratedSkill()];
    const after = await buildSkillInjection(opts);
    assert.strictEqual(after.systemPromptAddendum, before.systemPromptAddendum);
    assert.match(before.systemPromptAddendum, /Workflow: 1\. Read the request\n2\. Look up the price/);
    assert.strictEqual(after.staticCount, 1);
});

test('activate_skill renders byte-identically too (the dynamic path reads the same text)', async () => {
    const dyn = { dynamicActivation: true };
    mockSkills = [legacySkill(dyn)];
    const before = await executeActivateSkill({ args: { skill_ids: ['sk1'] }, orgId: 'org1', userId: 'u1' });
    mockSkills = [migratedSkill(dyn)];
    const after = await executeActivateSkill({ args: { skill_ids: ['sk1'] }, orgId: 'org1', userId: 'u1' });
    assert.strictEqual(after, before);
    assert.match(before, /Rules:\n- Never guess a price/);
});

test('a row with structure but no text is still rendered (defensive: the store always writes both)', async () => {
    mockSkills = [{
        ...legacySkill({ workflow: '', rules: '', examples: '' }),
        steps: [{ id: 's1', text: 'Read the request', refs: [] }, { id: 's2', text: 'Write the quote', refs: [] }],
        rulesV2: [{ id: 'r1', polarity: 'never', text: 'Never guess a price' }],
        examplesV2: [{ id: 'e1', question: 'How much?', good: 'EUR 120', rationale: '' }],
    }];
    const { systemPromptAddendum } = await buildSkillInjection(opts);
    assert.match(systemPromptAddendum, /Workflow: 1\. Read the request\n2\. Write the quote/);
    assert.match(systemPromptAddendum, /Rules: - Never guess a price/);
    assert.match(systemPromptAddendum, /Examples: Input: How much\?\nOutput: EUR 120/);
});

// ── the grants adapter (A1b / toolStackAssembly) ─────────────────────
test('skillGrantsOf: automations from the grant column, tables from step refs, KBs from both', () => {
    const g = skillGrantsOf({
        steps: [
            { id: 's1', text: 'Look it up', refs: [{ kind: 'kb', id: 'kb2' }, { kind: 'table', id: 'tbl1' }] },
            { id: 's2', text: 'And again', refs: [{ kind: 'table', id: 'tbl1' }, { kind: 'automation', id: 'auX' }] },
        ],
        knowledgeBaseIds: ['kb1', 'kb2'],
        allowedAutomationIds: ['au1'],
    });
    assert.deepStrictEqual(g.kbIds, ['kb1', 'kb2'], 'column ∪ refs, deduped');
    assert.deepStrictEqual(g.tableRefs, [{ id: 'tbl1', scope: 'own', readOnly: true }], 'read-only, own scope, deduped');
    assert.deepStrictEqual(g.automationIds, ['au1'], 'a step REFERENCE to an automation is presentation; "may use" is the grant');
    const empty = skillGrantsOf({});
    assert.deepStrictEqual(empty, { automationIds: [], tableRefs: [], kbIds: [] });
});

test('resolveSkillGrants merges the ACTIVE skills only; a dynamic skill grants nothing until it is activated', async () => {
    mockSkills = [
        { ...migratedSkill(), id: 'sk1', knowledgeBaseIds: ['kb1'], allowedAutomationIds: ['au1'], steps: [{ id: 's1', text: 'x', refs: [{ kind: 'table', id: 'tbl1' }] }] },
        { ...migratedSkill(), id: 'sk2', dynamicActivation: true, knowledgeBaseIds: ['kb9'], allowedAutomationIds: ['au9'], steps: [] },
    ];
    const base = { attachedSkillIds: ['sk1', 'sk2'], orgId: 'org1', userId: 'u1' };
    const g = await resolveSkillGrants(base);
    assert.deepStrictEqual(g.kbIds, ['kb1']);
    assert.deepStrictEqual(g.automationIds, ['au1']);
    assert.deepStrictEqual(g.tableRefs, [{ id: 'tbl1', scope: 'own', readOnly: true }]);
    assert.deepStrictEqual([...g.dynamicSkillGrants.keys()], ['sk2'], 'held back for the mid-conversation refresh');

    const activated = await resolveSkillGrants({ ...base, activatedSkillIds: ['sk2'] });
    assert.deepStrictEqual(activated.kbIds.sort(), ['kb1', 'kb9']);
    assert.deepStrictEqual(activated.automationIds.sort(), ['au1', 'au9']);
    assert.strictEqual(activated.dynamicSkillGrants.size, 0);

    // Flow tier demotes everything to dynamic — nothing is granted up front.
    const forced = await resolveSkillGrants({ ...base, forceDynamicSkills: true });
    assert.deepStrictEqual(forced.kbIds, []);
    assert.deepStrictEqual(forced.automationIds, []);
});

test('resolveSkillGrants fails closed: no org, no skills, a store error → no grants', async () => {
    mockSkills = [{ ...migratedSkill(), knowledgeBaseIds: ['kb1'] }];
    assert.deepStrictEqual((await resolveSkillGrants({ attachedSkillIds: ['sk1'], userId: 'u1' })).kbIds, [], 'no orgId → nothing');
    assert.deepStrictEqual((await resolveSkillGrants({ attachedSkillIds: [], orgId: 'org1', userId: 'u1' })).kbIds, []);
    const store = require('../../stores/skillStore');
    const original = store.getSkillsByIds;
    store.getSkillsByIds = async () => { throw new Error('db down'); };
    try {
        const g = await resolveSkillGrants(opts);
        assert.deepStrictEqual(g, { automationIds: [], tableRefs: [], kbIds: [], dynamicSkillGrants: new Map(), mergedIds: [] });
    } finally { store.getSkillsByIds = original; }
});

test('resolveSkillKbAllowlist is the KB-only view, with the not-yet-activated skills kept apart', async () => {
    mockSkills = [
        { ...migratedSkill(), id: 'sk1', knowledgeBaseIds: ['kb1'], steps: [{ id: 's1', text: 'x', refs: [{ kind: 'kb', id: 'kb2' }] }] },
        { ...migratedSkill(), id: 'sk2', dynamicActivation: true, knowledgeBaseIds: ['kb9'] },
    ];
    const r = await resolveSkillKbAllowlist({ attachedSkillIds: ['sk1', 'sk2'], orgId: 'org1', userId: 'u1' });
    assert.deepStrictEqual(r.kbIds, ['kb1', 'kb2']);
    assert.deepStrictEqual([...r.dynamicSkillKbs.entries()], [['sk2', ['kb9']]]);
    assert.deepStrictEqual(r.mergedIds, ['sk1', 'sk2']);
});

test('isDynamicSkill: the flag, an automation-linked skill, or the forced tier', () => {
    assert.strictEqual(isDynamicSkill({ dynamicActivation: false, automationId: null }), false);
    assert.strictEqual(isDynamicSkill({ dynamicActivation: true }), true);
    assert.strictEqual(isDynamicSkill({ automationId: 'au1' }), true);
    assert.strictEqual(isDynamicSkill({ dynamicActivation: false, automationId: null }, true), true);
});

// ── "Laatste keer" ───────────────────────────────────────────────────
test('the static path records an activation with the agent and conversation', async () => {
    mockSkills = [migratedSkill()];
    await buildSkillInjection({ ...opts, agentId: 'ag1', conversationId: 'c1' });
    await new Promise(r => setImmediate(r));
    assert.deepStrictEqual(activations, [{ skillIds: ['sk1'], agentId: 'ag1', conversationId: 'c1', userId: 'u1', source: 'static' }]);
});

test('activate_skill records its own activation, and a telemetry failure never breaks the tool', async () => {
    mockSkills = [migratedSkill({ dynamicActivation: true })];
    await executeActivateSkill({ args: { skill_ids: ['sk1'] }, orgId: 'org1', userId: 'u1', agentId: 'ag1', conversationId: 'c1' });
    await new Promise(r => setImmediate(r));
    assert.strictEqual(activations[0].source, 'activate_skill');

    const acts = require('../../stores/skillActivations');
    const original = acts.recordActivations;
    acts.recordActivations = async () => { throw new Error('db down'); };
    try {
        const out = await executeActivateSkill({ args: { skill_ids: ['sk1'] }, orgId: 'org1', userId: 'u1' });
        await new Promise(r => setImmediate(r));
        assert.match(out, /SKILL — "Quote helper"/, 'the skill body still comes back');
    } finally { acts.recordActivations = original; }
});

test('nothing static, nothing recorded (an all-dynamic agent must not claim a use)', async () => {
    mockSkills = [migratedSkill({ dynamicActivation: true })];
    const r = await buildSkillInjection({ ...opts, agentId: 'ag1', conversationId: 'c1' });
    await new Promise(res => setImmediate(res));
    assert.strictEqual(r.staticCount, 0);
    assert.deepStrictEqual(activations, []);
});

// ── the hang this file used to have ──────────────────────────────────
test('no real automation runtime or config store was ever loaded', () => {
    // The reason this file terminates without `--test-force-exit`. The config
    // store's LISTEN/NOTIFY reconnect loop holds the event loop open for
    // ever; it arrives through automationStore/automationRunner, which
    // `executeActivateSkill` requires on EVERY activation. Goes red the
    // moment a real one is back in the process.
    const stubs = new Map([
        [require.resolve('../../stores/automationStore'), 'getAutomation'],
        [require.resolve('../automationRunner'), 'executeAutomation'],
    ]);
    for (const [file, fn] of stubs) {
        const entry = require.cache[file];
        assert.ok(entry, `${file} is not in the cache — the stub was dropped`);
        assert.deepStrictEqual(Object.keys(entry.exports), [fn], `${file} is the REAL module, not the stub`);
    }
    const forbidden = [/stores[\\/]configStore\.js$/, /stores[\\/]notificationStore\.js$/];
    for (const pattern of forbidden) {
        assert.deepStrictEqual(
            Object.keys(require.cache).filter(f => pattern.test(f)), [],
            `a real module matching ${pattern} was loaded`,
        );
    }
});
