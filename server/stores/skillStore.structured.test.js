// @typecheck
/**
 * skillStore — structured fields (S1): the precedence rule on create and
 * update, the 400 on a string in a structured column, owner-or-manager
 * editing (cross-org refused by the WHERE), the usage scan (attachedSkillIds
 * element containment, the draft OR the published copy, so a draft-only user
 * still blocks a delete), the version bump, the last-20 test-run prune and
 * mapRow.
 *
 * Against a real Postgres: the boot ladder's schema on PGlite
 * (testUtils/pgliteTemplate.js ladderPglite) behind db.js's pool, so the
 * agents and automations the usage scan reads are real rows too.
 *
 * Run: node --test stores/skillStore.structured.test.js
 */

'use strict';

const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert');

process.env.NODE_ENV = 'test';

const { usePglitePool } = require('../testUtils/pglitePool');
const { ladderPglite } = require('../testUtils/pgliteTemplate');
const { insertRow } = require('../testUtils/pgliteSeed');
const { failReads, hideTable } = require('../testUtils/pgliteFaults');

const { pg, close } = usePglitePool(ladderPglite());
const store = require('./skillStore');
const { SkillStructureError } = require('../core/skills/skillStructure');

before(() => store.initDB());
after(close);
beforeEach(() => pg.exec('TRUNCATE skills, skill_test_runs, agents, automations CASCADE'));

/** @returns {any} */
const baseRow = (over = {}) => ({
    id: 'sk1', org_id: 'org1', user_id: 'owner', name: 'Quote helper', description: 'd', instructions: 'i',
    workflow: '1. Read\n2. Write', rules: '- Never guess', examples: 'Input: q\nOutput: a', icon: '⚡',
    is_shared: true, dynamic_activation: false, shared_groups: '[]', automation_id: null, enabled_integrations: '[]',
    steps: [{ id: 's1', text: 'Read', refs: [] }, { id: 's2', text: 'Write', refs: [] }],
    rules_v2: [{ id: 'r1', polarity: 'never', text: 'Never guess' }],
    examples_v2: [{ id: 'e1', question: 'q', good: 'a', rationale: '' }],
    output_schema: null, knowledge_base_ids: [], allowed_automation_ids: [], version: 3, last_used_at: null,
    created_at: '2026-09-01T00:00:00Z', updated_at: '2026-09-01T00:00:00Z',
    ...over,
});


const seedSkill = (over = {}) => insertRow(pg, 'skills', baseRow(over));
const storedSkill = async (id = 'sk1') => (await pg.query('SELECT * FROM skills WHERE id = $1', [id])).rows[0];
const writes = async (fn) => {
    const before = await storedSkill();
    await fn();
    return { before, after: await storedSkill() };
};

// ── createSkill ──────────────────────────────────────────────────────
test('createSkill with text only stores the text AND the parsed structure', async () => {
    const s = await store.createSkill({ orgId: 'org1', userId: 'u1', name: 'N', workflow: '1. A\n2. B', rules: 'Never guess', examples: 'Input: q\nOutput: a' });
    assert.strictEqual(s.workflow, '1. A\n2. B');
    assert.deepStrictEqual(s.steps.map((x) => x.text), ['A', 'B']);
    assert.strictEqual(s.rulesV2[0].polarity, 'never');
    assert.strictEqual(s.examplesV2[0].question, 'q');
    assert.strictEqual(s.version, 1);
    assert.strictEqual(s.outputSchema, null);
    const row = await storedSkill(s.id);
    assert.strictEqual(row.workflow, '1. A\n2. B');
    assert.deepStrictEqual(row.steps.map((x) => x.text), ['A', 'B'], 'steps column written');
    assert.strictEqual(row.rules_v2[0].polarity, 'never');
    assert.strictEqual(row.version, 1);
    assert.strictEqual(row.output_schema, null);
    assert.deepStrictEqual(store.mapRow(row).examplesV2, s.examplesV2, 'what is returned is what is stored');
});

test('createSkill with structure regenerates the text; a string in a structured field is a 400', async () => {
    const s = await store.createSkill({ orgId: 'org1', userId: 'u1', name: 'N', steps: [{ text: 'One' }, { text: 'Two' }], outputSchema: { properties: { amount: { type: 'number' } } }, knowledgeBaseIds: ['kb1', 'kb1'] });
    assert.strictEqual(s.workflow, '1. One\n2. Two');
    assert.deepStrictEqual(s.outputSchema, { type: 'object', properties: { amount: { type: 'number' } } });
    assert.deepStrictEqual(s.knowledgeBaseIds, ['kb1']);
    const row = store.mapRow(await storedSkill(s.id));
    assert.strictEqual(row.workflow, '1. One\n2. Two');
    assert.deepStrictEqual(row.outputSchema, s.outputSchema);
    assert.deepStrictEqual(row.knowledgeBaseIds, ['kb1']);
    await assert.rejects(store.createSkill({ orgId: 'org1', userId: 'u1', name: 'N2', steps: /** @type {any} */ ('1. One') }), (e) => e instanceof SkillStructureError && e.status === 400 && e.field === 'steps');
    assert.strictEqual((await pg.query(`SELECT count(*)::int AS n FROM skills WHERE name = 'N2'`)).rows[0].n, 0, 'nothing reached the database');
});

// ── updateSkill precedence ───────────────────────────────────────────
test('a text-only PUT after a structured save re-parses the text and overwrites the structure (text is the source)', async () => {
    await seedSkill();
    const { before, after } = await writes(() => store.updateSkill('sk1', 'owner', { workflow: '1. Phone edit' }));
    assert.strictEqual(after.workflow, '1. Phone edit');
    assert.deepStrictEqual(after.steps.map((x) => x.text), ['Phone edit']);
    for (const c of ['rules', 'rules_v2', 'examples', 'examples_v2']) assert.deepStrictEqual(after[c], before[c], `${c}: facets not sent are untouched`);
});

test('a structured PUT regenerates the text from the structure', async () => {
    await seedSkill();
    const { before, after } = await writes(() => store.updateSkill('sk1', 'owner', { rulesV2: [{ id: 'r1', polarity: 'must', text: 'Quote the source' }] }));
    assert.strictEqual(after.rules, '- Quote the source');
    assert.deepStrictEqual(after.rules_v2, [{ id: 'r1', polarity: 'must', text: 'Quote the source' }]);
    assert.strictEqual(after.workflow, before.workflow);
    assert.deepStrictEqual(after.steps, before.steps);
});

test('a rename never regenerates text from the stored structure', async () => {
    await seedSkill({ workflow: 'hand-written, not what the steps would print' });
    const { before, after } = await writes(() => store.updateSkill('sk1', 'owner', { name: 'Renamed' }));
    const changed = Object.keys(after).filter((k) => JSON.stringify(after[k]) !== JSON.stringify(before[k]));
    assert.deepStrictEqual(changed.sort(), ['name', 'updated_at', 'version']);
});

test('a string in a structured column on update is a 400 and nothing is written', async () => {
    await seedSkill();
    const before = await storedSkill();
    await assert.rejects(store.updateSkill('sk1', 'owner', { examplesV2: 'Input: q' }), (/** @type {any} */ e) => e.status === 400 && e.field === 'examplesV2');
    await assert.rejects(store.updateSkill('sk1', 'owner', { outputSchema: '{}' }), (/** @type {any} */ e) => e.status === 400 && e.field === 'outputSchema');
    assert.deepStrictEqual(await storedSkill(), before);
});

// ── version bump ─────────────────────────────────────────────────────
test('version bumps on a content change, not on a sharing change, not on a no-op save', async () => {
    await seedSkill();
    const version = async () => (await storedSkill()).version;
    await store.updateSkill('sk1', 'owner', { description: 'new description' });
    assert.strictEqual(await version(), 4);
    await store.updateSkill('sk1', 'owner', { isShared: false, sharedGroups: ['g1'], icon: '🐝' });
    assert.strictEqual(await version(), 4, 'sharing is not content');
    assert.strictEqual((await storedSkill()).is_shared, false);
    // Same content as stored → no bump (the 350ms autosave sends full snapshots).
    await store.updateSkill('sk1', 'owner', { description: 'new description', workflow: '1. Read\n2. Write' });
    assert.strictEqual(await version(), 4);
    await store.updateSkill('sk1', 'owner', { outputSchema: { properties: { x: { type: 'string' } } } });
    assert.strictEqual(await version(), 5);
});

// ── owner or manager ─────────────────────────────────────────────────
test('without managerOrgId only the owner may edit (mobile / legacy path unchanged)', async () => {
    await seedSkill();
    assert.strictEqual(await store.updateSkill('sk1', 'colleague', { name: 'x' }), false);
    assert.strictEqual((await storedSkill()).name, 'Quote helper');
    assert.strictEqual(await store.updateSkill('sk1', 'owner', { name: 'x' }), true);
    assert.strictEqual((await storedSkill()).name, 'x');
});

test('with managerOrgId a non-owner in the SAME org may edit; a personal skill stays the owner\'s', async () => {
    await seedSkill();
    assert.strictEqual(await store.updateSkill('sk1', 'colleague', { name: 'x' }, { managerOrgId: 'org1' }), true);
    assert.strictEqual((await storedSkill()).name, 'x');
    await seedSkill({ id: 'sk-personal', org_id: null });
    assert.strictEqual(await store.updateSkill('sk-personal', 'colleague', { name: 'y' }, { managerOrgId: 'org1' }), false);
    assert.strictEqual((await storedSkill('sk-personal')).name, 'Quote helper');
});

test('cross-org: a manager of another org changes nothing', async () => {
    await seedSkill();
    const before = await storedSkill();
    assert.strictEqual(await store.updateSkill('sk1', 'stranger', { name: 'x' }, { managerOrgId: 'org2' }), false);
    assert.deepStrictEqual(await storedSkill(), before);
});

test('canEditSkill: manage_skills is required; then owner, or same org', () => {
    const s = store.mapRow(baseRow());
    assert.strictEqual(store.canEditSkill(s, 'owner', { orgId: 'org1', canManage: true }), true);
    assert.strictEqual(store.canEditSkill(s, 'owner', { orgId: 'org1', canManage: false }), false);
    assert.strictEqual(store.canEditSkill(s, 'colleague', { orgId: 'org1', canManage: true }), true);
    assert.strictEqual(store.canEditSkill(s, 'stranger', { orgId: 'org2', canManage: true }), false);
    const personal = store.mapRow(baseRow({ org_id: null }));
    assert.strictEqual(store.canEditSkill(personal, 'colleague', { orgId: null, canManage: true }), false, 'a personal skill is never org-editable');
});

test('getAvailableSkills with a viewer adds canEdit per row and lastTest when asked', async () => {
    await seedSkill({ created_at: '2026-09-02T00:00:00Z' });
    await seedSkill({ id: 'sk2', user_id: 'colleague', created_at: '2026-09-01T00:00:00Z' });
    await seedSkill({ id: 'sk-other-org', org_id: 'org2' });
    await insertRow(pg, 'skill_test_runs', { id: 't1', skill_id: 'sk2', status: 'ok', results: [], ran_at: '2026-09-02T10:00:00Z' });
    await insertRow(pg, 'skill_test_runs', {
        id: 't2', skill_id: 'sk2', status: 'warning', advice: 'Add a table ref', ran_at: '2026-09-03T10:00:00Z',
        results: [{ stepId: 's1', status: 'ok' }, { stepId: 's2', status: 'warning' }],
    });
    const rows = await store.getAvailableSkills('org1', 'owner', { canManage: true, withLastTest: true });
    assert.deepStrictEqual(rows.map((r) => [r.id, r.canEdit]), [['sk1', true], ['sk2', true]]);
    const asViewer = await store.getAvailableSkills('org1', 'owner', { canManage: false });
    assert.deepStrictEqual(asViewer.map((r) => r.canEdit), [false, false], 'no manage_skills → read-only everywhere');
    const plain = await store.getAvailableSkills('org1', 'owner');
    assert.ok(!('canEdit' in plain[0]) && !('lastTest' in plain[0]), 'legacy callers get the legacy shape');
    assert.strictEqual(rows[0].lastTest, null);
    assert.deepStrictEqual(rows[1].lastTest, { status: 'warning', adviceCount: 1, ranAt: '2026-09-03T10:00:00.000Z' }, 'the newest run');
});

// ── usage ────────────────────────────────────────────────────────────

const agent = (over) => insertRow(pg, 'agents', { owner_id: 'owner', organization_id: 'org1', ...over });
const automation = (over) => insertRow(pg, 'automations', { user_id: 'colleague', organization_id: 'org1', title: 'A', definition_json: { steps: [] }, ...over });

test('the usage scan finds an agent by an element of attachedSkillIds and an AI step by its skillIds, scoped to the org', async () => {
    await agent({ id: 'a1', name: 'Offerte-assistent', config: JSON.stringify({ attachedSkillIds: ['sk1', 'sk3'] }) });
    await agent({ id: 'a-key', name: 'Key only', config: JSON.stringify({ sk1: true, attachedSkillIds: [] }) });
    await agent({ id: 'a-empty', name: 'Empty config', config: '' });
    await agent({ id: 'a-object', name: 'Object', config: JSON.stringify({ attachedSkillIds: { sk1: 1 } }) });
    await agent({ id: 'a-org2', name: 'Other org', organization_id: 'org2', config: JSON.stringify({ attachedSkillIds: ['sk1'] }) });
    await automation({
        id: 'au1', title: 'Offerte versturen', last_run_at: '2026-09-02T00:00:00Z', is_active: true,
        definition_json: { steps: [{ id: 'ai_3', label: '3', type: 'ai_step', skillIds: ['sk1'] }, { id: 'x', type: 'http', skillIds: ['sk1'] }] },
    });
    await automation({ id: 'au2', title: 'Layered', definition_json: { steps: [], layers: { inner: { steps: [{ id: 'ai_9', type: 'ai_step', skillIds: ['sk1'] }] } } } });
    await automation({ id: 'au-org2', organization_id: 'org2', definition_json: { steps: [{ id: 's', type: 'ai_step', skillIds: ['sk1'] }] } });

    const usage = await store.listSkillUsage('sk1', 'org1');
    assert.deepStrictEqual(usage, {
        rows: [
            { kind: 'agent', id: 'a1', title: 'Offerte-assistent', role: 'chat', lastAt: null, ownerId: 'owner' },
            { kind: 'automation', id: 'au1', title: 'Offerte versturen', role: 'ai_step', siteLabel: 'step 3', stepId: 'ai_3', layerKey: null, lastAt: '2026-09-02T00:00:00.000Z', ownerId: 'colleague' },
            { kind: 'automation', id: 'au2', title: 'Layered', role: 'ai_step', siteLabel: 'step ai_9', stepId: 'ai_9', layerKey: 'inner', lastAt: null, ownerId: 'colleague' },
        ],
        unchecked: [],
    }, "a top-level key is not an element, '' and a non-array never abort the scan, another org is never read");
});

/**
 * An agent stores its skills twice: `config` (the draft) and
 * `published_config` (what the runtime reads). The delete guard is built from
 * this list, so either copy must keep the skill in use: a precedence
 * (published over draft) would drop an agent that attaches the skill in its
 * DRAFT only once it has ever been published.
 */
test('the agent scan reads the draft and the published config, either one keeps the skill in use', async () => {
    await agent({ id: 'a-draft', name: 'Draft only', config: JSON.stringify({ attachedSkillIds: ['sk1'] }), published_config: { attachedSkillIds: [] } });
    await agent({ id: 'a-pub', name: 'Published only', config: JSON.stringify({ attachedSkillIds: [] }), published_config: { attachedSkillIds: ['sk1'] } });
    await agent({ id: 'a-none', name: 'Neither', config: JSON.stringify({ attachedSkillIds: [] }), published_config: { attachedSkillIds: [] } });
    const usage = await store.listSkillUsage('sk1', 'org1');
    assert.deepStrictEqual(usage.rows.map((r) => r.id), ['a-draft', 'a-pub']);
});

/** An install whose agents table predates published_config. */
async function withoutPublishedConfig(fn) {
    await pg.exec('ALTER TABLE agents RENAME COLUMN published_config TO published_config_aside');
    try { return await fn(); } finally { await pg.exec('ALTER TABLE agents RENAME COLUMN published_config_aside TO published_config'); }
}

test('an install without agents.published_config narrows to the draft scan instead of failing', async () => {
    await agent({ id: 'a1', name: 'Offerte-assistent', config: JSON.stringify({ attachedSkillIds: ['sk1'] }) });
    const usage = await withoutPublishedConfig(() => store.listSkillUsage('sk1', 'org1'));
    assert.deepStrictEqual(usage.rows.map((r) => r.id), ['a1'], 'and it still answers');
    assert.deepStrictEqual(usage.unchecked, [], 'the agents fallback is a narrowing, not a gap');
});

test('any OTHER failure of the agent scan is rethrown — a broken guard must not read as "unused"', async () => {
    const restore = await failReads(pg, 'agents', '08006', 'connection terminated');
    try {
        await assert.rejects(() => store.listSkillUsage('sk1', 'org1'), /connection terminated/);
    } finally { await restore(); }
});

test('an unused skill yields no rows and no gaps — the shape the 409 guard and the delete dialog rely on', async () => {
    await agent({ id: 'a1', name: 'Other skill', config: JSON.stringify({ attachedSkillIds: ['sk2'] }) });
    assert.deepStrictEqual(await store.listSkillUsage('sk1', 'org1'), { rows: [], unchecked: [] });
    assert.deepStrictEqual(await store.listSkillUsage('', 'org1'), { rows: [], unchecked: [] });
});

/**
 * An install with no automations has no `automations` table. That is
 * supported, but it is not a count either: "No agent or automation uses this
 * skill yet" must not be printable over a kind nobody scanned.
 */
test('a missing automations table is NAMED, not folded into an empty list', async () => {
    await agent({ id: 'a1', name: 'Offerte-assistent', config: JSON.stringify({ attachedSkillIds: ['sk1'] }) });
    const restore = await hideTable(pg, 'automations');
    try {
        const usage = await store.listSkillUsage('sk1', 'org1');
        assert.deepStrictEqual(usage.unchecked, ['automation']);
        assert.strictEqual(usage.rows.length, 1, 'the agents half still answers');
        const sum = await store.getUsageSummary('org1', ['sk1']);
        assert.strictEqual(sum.sk1.automationsUnchecked, true);
        assert.strictEqual(sum.sk1.automations, 0, 'the number stays 0; the flag is what says it was never counted');
    } finally { await restore(); }
});

test('and any OTHER failure of the step scan is still rethrown', async () => {
    const restore = await failReads(pg, 'automations', '08006', 'connection terminated');
    try {
        await assert.rejects(() => store.listSkillUsage('sk1', 'org1'), /connection terminated/);
    } finally { await restore(); }
});

test('getUsageSummary counts per kind, both agent copies, and an agent carrying the skill in both counts ONCE', async () => {
    await agent({ id: 'a1', name: 'Both', config: JSON.stringify({ attachedSkillIds: ['sk1'] }), published_config: { attachedSkillIds: ['sk1'] } });
    await agent({ id: 'a2', name: 'Published', config: '', published_config: { attachedSkillIds: ['sk1'] } });
    await agent({ id: 'a3', name: 'Not an array', config: JSON.stringify({ attachedSkillIds: 'sk1' }) });
    await automation({ id: 'au1', definition_json: { steps: [{ id: 'a', type: 'ai_step', skillIds: ['sk1'] }, { id: 'b', type: 'ai_step', skillIds: ['sk1'] }] } });
    const sum = await store.getUsageSummary('org1', ['sk1', 'sk9']);
    assert.deepStrictEqual(sum, { sk1: { agents: 2, automations: 1, lastUsedAt: null }, sk9: { agents: 0, automations: 0, lastUsedAt: null } });
});

test('the summary also survives an install without agents.published_config', async () => {
    await agent({ id: 'a1', name: 'Draft', config: JSON.stringify({ attachedSkillIds: ['sk1'] }) });
    const sum = await withoutPublishedConfig(() => store.getUsageSummary('org1', ['sk1']));
    assert.deepStrictEqual(sum, { sk1: { agents: 1, automations: 0, lastUsedAt: null } });
});

// ── test runs ────────────────────────────────────────────────────────
test('recordTestRun inserts, then prunes to the last 20 per skill', async () => {
    await insertRow(pg, 'skill_test_runs', { id: 'other', skill_id: 'sk2', status: 'ok', ran_at: '2020-01-01T00:00:00Z' });
    const first = await store.recordTestRun({ skillId: 'sk1', agentId: 'a1', question: 'How much?', results: [{ stepId: 's1', title: 'Read', evidence: 'ok', status: 'ok' }], status: 'ok' });
    assert.strictEqual(first.status, 'ok');
    const row = (await pg.query('SELECT * FROM skill_test_runs WHERE id = $1', [first.id])).rows[0];
    assert.strictEqual(row.question, 'How much?');
    assert.deepStrictEqual(row.results, [{ stepId: 's1', title: 'Read', evidence: 'ok', status: 'ok' }]);
    for (let i = 0; i < 21; i++) await store.recordTestRun(/** @type {any} */ ({ skillId: 'sk1', status: 'ok' }));
    const kept = (await pg.query('SELECT id, skill_id FROM skill_test_runs')).rows;
    assert.strictEqual(store.TEST_RUNS_KEEP, 20);
    assert.strictEqual(kept.filter((r) => r.skill_id === 'sk1').length, 20);
    assert.ok(!kept.some((r) => r.id === first.id), 'the oldest run of the skill went first');
    assert.ok(kept.some((r) => r.id === 'other'), 'another skill\'s history is untouched');
    // Unknown NARROWS: never the reassuring value on a screen whose only job
    // is to say whether somebody's skill works.
    const bad = await store.recordTestRun(/** @type {any} */ ({ skillId: 'sk1', status: 'nonsense' }));
    assert.strictEqual(bad.status, 'error', 'unknown status is not a pass');
    assert.strictEqual((await pg.query('SELECT status FROM skill_test_runs WHERE id = $1', [bad.id])).rows[0].status, 'error');
    const none = await store.recordTestRun(/** @type {any} */ ({ skillId: 'sk1' }));
    assert.strictEqual(none.status, 'error', 'no status at all is not a pass either');
});

// ── mapRow ───────────────────────────────────────────────────────────
test('mapRow presents NULL structure as [] and keeps every legacy field (mobile reads them)', () => {
    const s = store.mapRow(baseRow({ steps: null, rules_v2: null, examples_v2: null, output_schema: '{"type":"object","properties":{"a":{"type":"string"}}}', version: null }));
    assert.deepStrictEqual(s.steps, []);
    assert.deepStrictEqual(s.rulesV2, []);
    assert.deepStrictEqual(s.examplesV2, []);
    assert.deepStrictEqual(s.outputSchema, { type: 'object', properties: { a: { type: 'string' } } });
    assert.strictEqual(s.version, 1);
    for (const k of ['id', 'orgId', 'userId', 'name', 'description', 'instructions', 'workflow', 'rules', 'examples', 'icon', 'isShared', 'dynamicActivation', 'sharedGroups', 'automationId', 'enabledIntegrations', 'createdAt', 'updatedAt']) {
        assert.ok(k in s, `legacy field ${k} present`);
    }
    for (const k of ['steps', 'rulesV2', 'examplesV2', 'outputSchema', 'knowledgeBaseIds', 'allowedAutomationIds', 'version', 'lastUsedAt']) {
        assert.ok(k in s, `new field ${k} present`);
    }
});
