/**
 * skillStore — structured fields (S1): the precedence rule on create and
 * update, the 400 on a string in a structured column, owner-or-manager
 * editing (cross-org refused by the WHERE), the usage scan
 * (`(config::jsonb->'attachedSkillIds') ? $1`, UNION-ed with the published
 * copy so a draft-only user still blocks a delete), the version bump, the
 * last-20 test-run prune and mapRow.
 *
 * DB-free: ../db and ./userStore are stubbed via require.cache.
 *
 * Run: node --test --test-force-exit stores/skillStore.structured.test.js
 */

const { test, beforeEach } = require('node:test');
const assert = require('node:assert');

process.env.NODE_ENV = 'test';

const calls = [];
const state = {
    currentRow: null, rowCount: 1, agents: [], steps: [], testRuns: [], skillRows: [],
    // An install whose agents table predates A1 (no `published_config`),
    // and a scan that fails for any OTHER reason.
    noPublishedConfig: false, agentScanError: null,
    // …and a step scan that fails: `42P01` (no automations table on an
    // install without routines) must be NAMED, anything else rethrown.
    stepScanError: null,
};

function mock(request, exports) {
    const p = require.resolve(request);
    require.cache[p] = { id: p, filename: p, loaded: true, exports };
}

const norm = (sql) => sql.replace(/\s+/g, ' ').trim();

mock('../db', {
    exec: async () => undefined,
    run: async (sql, params = []) => { calls.push({ kind: 'run', sql: norm(sql), params }); return { rowCount: state.rowCount, rows: [] }; },
    getOne: async (sql, params = []) => {
        calls.push({ kind: 'getOne', sql: norm(sql), params });
        // The manager predicate names the caller's org: another org never matches.
        if (/^SELECT \* FROM skills WHERE id = \$1/.test(norm(sql))) return params.includes('org2') ? null : state.currentRow;
        return null;
    },
    getAll: async (sql, params = []) => {
        const s = norm(sql);
        calls.push({ kind: 'getAll', sql: s, params });
        // Thrown ONCE: a store that swallowed it and retried would then
        // succeed silently, which is exactly the behaviour under test.
        if (/FROM agents/.test(s) && state.agentScanError) {
            const err = state.agentScanError; state.agentScanError = null; throw err;
        }
        if (/FROM automations a/.test(s) && state.stepScanError) {
            const err = state.stepScanError; state.stepScanError = null; throw err;
        }
        if (/published_config/.test(s) && state.noPublishedConfig) {
            const err = new Error('column "published_config" does not exist');
            err.code = '42703';
            throw err;
        }
        if (/^SELECT \* FROM skills/.test(s)) return state.skillRows;
        if (/FROM agents/.test(s) && /jsonb_array_elements_text/.test(s)) return state.agents.map(_a => ({ skill_id: params[1][0], n: 1 }));
        if (/FROM agents/.test(s)) return state.agents;
        if (/FROM automations a/.test(s) && /COUNT\(DISTINCT/.test(s)) return [];
        if (/FROM automations a/.test(s)) return state.steps;
        if (/DISTINCT ON \(skill_id\)/.test(s) && /skill_test_runs/.test(s)) return state.testRuns;
        if (/SELECT id, last_used_at FROM skills/.test(s)) return [];
        return [];
    },
    makeStoreInit: (tag, fn) => { let p = null; return () => (p ||= Promise.resolve().then(fn)); },
});
mock('./userStore', { getUser: async () => ({ id: 'u1', groups: [] }) });
mock('./githubSyncStore', { getOrgSyncConfig: async () => null });

const store = require('./skillStore');
const { SkillStructureError } = require('../core/skills/skillStructure');

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

function lastUpdate() {
    const c = [...calls].reverse().find(x => x.kind === 'run' && /^UPDATE skills SET/.test(x.sql));
    assert.ok(c, 'expected an UPDATE skills');
    const cols = {};
    for (const m of c.sql.matchAll(/(\w+) = \$(\d+)/g)) cols[m[1]] = c.params[Number(m[2]) - 1];
    return { sql: c.sql, params: c.params, cols };
}

beforeEach(() => {
    calls.length = 0; state.currentRow = baseRow(); state.rowCount = 1;
    state.agents = []; state.steps = []; state.testRuns = [];
    state.noPublishedConfig = false; state.agentScanError = null; state.stepScanError = null;
});

// ── createSkill ──────────────────────────────────────────────────────
test('createSkill with text only stores the text AND the parsed structure', async () => {
    const s = await store.createSkill({ orgId: 'org1', userId: 'u1', name: 'N', workflow: '1. A\n2. B', rules: 'Never guess', examples: 'Input: q\nOutput: a' });
    const ins = calls.find(c => /^INSERT INTO skills/.test(c.sql));
    assert.ok(ins);
    assert.strictEqual(s.workflow, '1. A\n2. B');
    assert.deepStrictEqual(s.steps.map(x => x.text), ['A', 'B']);
    assert.strictEqual(s.rulesV2[0].polarity, 'never');
    assert.strictEqual(s.examplesV2[0].question, 'q');
    assert.strictEqual(s.version, 1);
    assert.strictEqual(s.outputSchema, null);
    assert.deepStrictEqual(JSON.parse(ins.params[15]).map(x => x.text), ['A', 'B'], 'steps column written');
});

test('createSkill with structure regenerates the text; a string in a structured field is a 400', async () => {
    const s = await store.createSkill({ orgId: 'org1', userId: 'u1', name: 'N', steps: [{ text: 'One' }, { text: 'Two' }], outputSchema: { properties: { amount: { type: 'number' } } }, knowledgeBaseIds: ['kb1', 'kb1'] });
    assert.strictEqual(s.workflow, '1. One\n2. Two');
    assert.deepStrictEqual(s.outputSchema, { type: 'object', properties: { amount: { type: 'number' } } });
    assert.deepStrictEqual(s.knowledgeBaseIds, ['kb1']);
    calls.length = 0;
    await assert.rejects(store.createSkill({ orgId: 'org1', userId: 'u1', name: 'N', steps: '1. One' }), (e) => e instanceof SkillStructureError && e.status === 400 && e.field === 'steps');
    assert.strictEqual(calls.filter(c => c.kind === 'run').length, 0, 'nothing reached the database');
});

// ── updateSkill precedence ───────────────────────────────────────────
test('a text-only PUT after a structured save re-parses the text and overwrites the structure (text is the source)', async () => {
    await store.updateSkill('sk1', 'owner', { workflow: '1. Phone edit' });
    const { cols } = lastUpdate();
    assert.strictEqual(cols.workflow, '1. Phone edit');
    assert.deepStrictEqual(JSON.parse(cols.steps).map(x => x.text), ['Phone edit']);
    assert.ok(!('rules' in cols) && !('rules_v2' in cols) && !('examples' in cols) && !('examples_v2' in cols), 'facets not sent are untouched');
});

test('a structured PUT regenerates the text from the structure', async () => {
    await store.updateSkill('sk1', 'owner', { rulesV2: [{ id: 'r1', polarity: 'must', text: 'Quote the source' }] });
    const { cols } = lastUpdate();
    assert.strictEqual(cols.rules, '- Quote the source');
    assert.deepStrictEqual(JSON.parse(cols.rules_v2), [{ id: 'r1', polarity: 'must', text: 'Quote the source' }]);
    assert.ok(!('workflow' in cols) && !('steps' in cols));
});

test('a rename never regenerates text from the stored structure', async () => {
    await store.updateSkill('sk1', 'owner', { name: 'Renamed' });
    const { cols } = lastUpdate();
    assert.deepStrictEqual(Object.keys(cols).filter(k => k !== 'id' && k !== 'user_id'), ['name']);
});

test('a string in a structured column on update is a 400 and nothing is written', async () => {
    await assert.rejects(store.updateSkill('sk1', 'owner', { examplesV2: 'Input: q' }), (e) => e.status === 400 && e.field === 'examplesV2');
    await assert.rejects(store.updateSkill('sk1', 'owner', { outputSchema: '{}' }), (e) => e.status === 400 && e.field === 'outputSchema');
    assert.strictEqual(calls.filter(c => c.kind === 'run').length, 0);
});

// ── version bump ─────────────────────────────────────────────────────
test('version bumps on a content change, not on a sharing change, not on a no-op save', async () => {
    await store.updateSkill('sk1', 'owner', { description: 'new description' });
    assert.match(lastUpdate().sql, /version = version \+ 1/);
    calls.length = 0;
    await store.updateSkill('sk1', 'owner', { isShared: false, sharedGroups: ['g1'], icon: '🐝' });
    assert.doesNotMatch(lastUpdate().sql, /version = version \+ 1/);
    calls.length = 0;
    // Same content as stored → no bump (the 350ms autosave sends full snapshots).
    await store.updateSkill('sk1', 'owner', { description: 'd', workflow: '1. Read\n2. Write' });
    assert.doesNotMatch(lastUpdate().sql, /version = version \+ 1/);
    calls.length = 0;
    await store.updateSkill('sk1', 'owner', { outputSchema: { properties: { x: { type: 'string' } } } });
    assert.match(lastUpdate().sql, /version = version \+ 1/);
});

// ── owner or manager ─────────────────────────────────────────────────
test('without managerOrgId the WHERE pins the owner (mobile / legacy path unchanged)', async () => {
    await store.updateSkill('sk1', 'owner', { name: 'x' });
    const { sql, params } = lastUpdate();
    assert.match(sql, /WHERE id = \$\d+ AND user_id = \$\d+$/);
    assert.deepStrictEqual(params.slice(-2), ['sk1', 'owner']);
});

test('with managerOrgId a non-owner in the SAME org may edit; the WHERE names that org', async () => {
    const ok = await store.updateSkill('sk1', 'colleague', { name: 'x' }, { managerOrgId: 'org1' });
    assert.strictEqual(ok, true);
    const { sql, params } = lastUpdate();
    assert.match(sql, /WHERE id = \$\d+ AND \(user_id = \$\d+ OR \(org_id IS NOT NULL AND org_id = \$\d+\)\)$/);
    assert.deepStrictEqual(params.slice(-3), ['sk1', 'colleague', 'org1']);
});

test('cross-org: a manager of another org is refused before any UPDATE', async () => {
    // The pre-read carries the same predicate, so the row is simply not found.
    const ok = await store.updateSkill('sk1', 'stranger', { name: 'x' }, { managerOrgId: 'org2' });
    assert.strictEqual(ok, false);
    assert.strictEqual(calls.filter(c => c.kind === 'run').length, 0);
    const read = calls.find(c => c.kind === 'getOne');
    assert.match(read.sql, /\(user_id = \$2 OR \(org_id IS NOT NULL AND org_id = \$3\)\)/);
    assert.deepStrictEqual(read.params, ['sk1', 'stranger', 'org2']);
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
    state.skillRows = [baseRow(), baseRow({ id: 'sk2', user_id: 'colleague' })];
    state.testRuns = [{ skill_id: 'sk2', status: 'warning', advice: 'Add a table ref', results: [{ stepId: 's1', status: 'ok' }, { stepId: 's2', status: 'warning' }], ran_at: '2026-09-03T10:00:00Z' }];
    const rows = await store.getAvailableSkills('org1', 'owner', { canManage: true, withLastTest: true });
    assert.deepStrictEqual(rows.map(r => [r.id, r.canEdit]), [['sk1', true], ['sk2', true]]);
    const asViewer = await store.getAvailableSkills('org1', 'owner', { canManage: false });
    assert.deepStrictEqual(asViewer.map(r => r.canEdit), [false, false], 'no manage_skills → read-only everywhere');
    const plain = await store.getAvailableSkills('org1', 'owner');
    assert.ok(!('canEdit' in plain[0]) && !('lastTest' in plain[0]), 'legacy callers get the legacy shape');
    assert.strictEqual(rows[0].lastTest, null);
    assert.deepStrictEqual(rows[1].lastTest, { status: 'warning', adviceCount: 1, ranAt: '2026-09-03T10:00:00.000Z' });
});

// ── usage ────────────────────────────────────────────────────────────
test('the agent scan uses array-element containment on attachedSkillIds, scoped to the org', async () => {
    state.agents = [{ id: 'a1', name: 'Offerte-assistent', owner_id: 'owner', organization_id: 'org1' }];
    state.steps = [{ id: 'au1', title: 'Offerte versturen', user_id: 'colleague', last_run_at: '2026-09-02T00:00:00Z', is_active: true, step_id: 'ai_3', step_label: '3', layer_key: null }];
    const usage = await store.listSkillUsage('sk1', 'org1');
    const scan = calls.find(c => c.kind === 'getAll' && /FROM agents/.test(c.sql));
    assert.match(scan.sql, /->'attachedSkillIds'\) \? \$1/, 'array-element containment');
    assert.doesNotMatch(scan.sql, /config, ''\)::jsonb \? \$1/, "a bare `config::jsonb ? $1` tests a top-level key and never matches");
    assert.match(scan.sql, /NULLIF\(config, ''\)::jsonb/, "agents.config is TEXT: one '' row must not abort the whole scan");
    assert.match(scan.sql, /organization_id IS NOT DISTINCT FROM \$2/);
    assert.deepStrictEqual(scan.params, ['sk1', 'org1']);
    assert.deepStrictEqual(usage, {
        rows: [
            { kind: 'agent', id: 'a1', title: 'Offerte-assistent', role: 'chat', lastAt: null, ownerId: 'owner' },
            { kind: 'automation', id: 'au1', title: 'Offerte versturen', role: 'ai_step', siteLabel: 'step 3', stepId: 'ai_3', layerKey: null, lastAt: '2026-09-02T00:00:00.000Z', ownerId: 'colleague' },
        ],
        unchecked: [],
    });
    const stepScan = calls.find(c => c.kind === 'getAll' && /FROM automations a/.test(c.sql));
    assert.match(stepScan.sql, /step->>'type' = 'ai_step'/);
    assert.match(stepScan.sql, /\(step->'skillIds'\) \? \$1/);
    assert.match(stepScan.sql, /jsonb_each\(/, 'inline layers are scanned too');
});

/**
 * An agent stores its skills twice: `config` (the draft) and
 * `published_config` (what the runtime reads). The delete guard is built
 * from this list, so the combination is a safety decision:
 * `COALESCE(published_config, config)` would drop an agent that attaches the
 * skill in its DRAFT only as soon as it has ever been published, and the 409
 * guard would then say "nothing uses this" over a draft it is about to break.
 */
test('the agent scan is the UNION of the draft and the published config, never COALESCE', async () => {
    state.agents = [{ id: 'a1', name: 'Offerte-assistent', owner_id: 'owner', organization_id: 'org1' }];
    await store.listSkillUsage('sk1', 'org1');
    const scan = calls.find(c => c.kind === 'getAll' && /FROM agents/.test(c.sql));
    assert.match(scan.sql, /NULLIF\(config, ''\)::jsonb->'attachedSkillIds'\) \? \$1/, 'the draft is still read');
    assert.match(scan.sql, /published_config->'attachedSkillIds'\) \? \$1/, 'the published copy is read too');
    assert.match(scan.sql, /\) OR \(/, 'OR-ed, so either copy keeps the skill in use');
    assert.doesNotMatch(scan.sql, /COALESCE/i, 'precedence would hide a draft-only user from the delete guard');
});

test('an install without agents.published_config narrows to the draft scan instead of failing', async () => {
    state.noPublishedConfig = true;
    state.agents = [{ id: 'a1', name: 'Offerte-assistent', owner_id: 'owner', organization_id: 'org1' }];
    const usage = await store.listSkillUsage('sk1', 'org1');
    const scans = calls.filter(c => c.kind === 'getAll' && /FROM agents/.test(c.sql));
    assert.strictEqual(scans.length, 2, 'it tries the union first, then falls back');
    assert.doesNotMatch(scans[1].sql, /published_config/, 'the retry asks only for what the table has');
    assert.match(scans[1].sql, /NULLIF\(config, ''\)::jsonb->'attachedSkillIds'\) \? \$1/);
    assert.deepStrictEqual(scans[1].params, ['sk1', 'org1']);
    assert.strictEqual(usage.rows.length, 1, 'and it still answers');
    assert.deepStrictEqual(usage.unchecked, [], 'the agents fallback is a narrowing, not a gap');
});

test('any OTHER failure of the agent scan is rethrown — a broken guard must not read as "unused"', async () => {
    state.agentScanError = Object.assign(new Error('connection terminated'), { code: '08006' });
    await assert.rejects(() => store.listSkillUsage('sk1', 'org1'), /connection terminated/);
});

test('an unused skill yields no rows and no gaps — the shape the 409 guard and the delete dialog rely on', async () => {
    assert.deepStrictEqual(await store.listSkillUsage('sk1', 'org1'), { rows: [], unchecked: [] });
    assert.deepStrictEqual(await store.listSkillUsage('', 'org1'), { rows: [], unchecked: [] });
});

/**
 * ── AND THE ONE CASE WHERE [] IS NOT AN ANSWER ──────────────────────
 * An install with no routines has no `automations` table. That is supported,
 * not an error — but it is also not a count, and this function feeds the two
 * loudest claims in the product: "No agent or automation uses this skill yet"
 * on the tab, and "can be deleted without breaking anything else" on the
 * delete card. Folding the missing table into `[]` made both of those
 * sentences printable over a kind nobody had scanned.
 */
test('a missing automations table is NAMED, not folded into an empty list', async () => {
    state.stepScanError = Object.assign(new Error('relation "automations" does not exist'), { code: '42P01' });
    state.agents = [{ id: 'a1', name: 'Offerte-assistent', owner_id: 'owner', organization_id: 'org1' }];
    const usage = await store.listSkillUsage('sk1', 'org1');
    assert.deepStrictEqual(usage.unchecked, ['automation']);
    assert.strictEqual(usage.rows.length, 1, 'the agents half still answers');
});

test('and any OTHER failure of the step scan is still rethrown', async () => {
    state.stepScanError = Object.assign(new Error('connection terminated'), { code: '08006' });
    await assert.rejects(() => store.listSkillUsage('sk1', 'org1'), /connection terminated/);
});

/**
 * The summary has the same silence in it, and the list's second line
 * ("not linked yet") is built from it.
 */
test('getUsageSummary marks the automations column as unchecked instead of counting it as zero', async () => {
    state.stepScanError = Object.assign(new Error('relation "automations" does not exist'), { code: '42P01' });
    const sum = await store.getUsageSummary('org1', ['sk1']);
    assert.strictEqual(sum.sk1.automationsUnchecked, true);
    assert.strictEqual(sum.sk1.automations, 0, 'the number stays 0; the flag is what says it was never counted');
});

test('getUsageSummary returns zeros for unused skills and counts per kind', async () => {
    state.agents = [{ id: 'a1' }];
    const sum = await store.getUsageSummary('org1', ['sk1', 'sk9']);
    assert.deepStrictEqual(sum, { sk1: { agents: 1, automations: 0, lastUsedAt: null }, sk9: { agents: 0, automations: 0, lastUsedAt: null } });
    const q = calls.find(c => c.kind === 'getAll' && /jsonb_array_elements_text/.test(c.sql) && /FROM agents/.test(c.sql));
    assert.match(q.sql, /jsonb_typeof\(NULLIF\(a\.config, ''\)::jsonb->'attachedSkillIds'\) = 'array'/, 'a non-array value must not blow up the whole summary');
});

test('the summary counts both copies, and an agent carrying the skill in both counts ONCE', async () => {
    state.agents = [{ id: 'a1' }];
    await store.getUsageSummary('org1', ['sk1']);
    const q = calls.find(c => c.kind === 'getAll' && /jsonb_array_elements_text/.test(c.sql) && /FROM agents/.test(c.sql));
    assert.match(q.sql, /published_config->'attachedSkillIds'/, 'the published copy is counted too');
    assert.match(q.sql, /UNION ALL/);
    assert.match(q.sql, /COUNT\(DISTINCT agent_id\)/, 'draft + published is still one agent');
    assert.doesNotMatch(q.sql, /COALESCE/i);
});

test('the summary also survives an install without agents.published_config', async () => {
    state.noPublishedConfig = true;
    state.agents = [{ id: 'a1' }];
    const sum = await store.getUsageSummary('org1', ['sk1']);
    assert.deepStrictEqual(sum, { sk1: { agents: 1, automations: 0, lastUsedAt: null } });
    const scans = calls.filter(c => c.kind === 'getAll' && /jsonb_array_elements_text/.test(c.sql) && /FROM agents/.test(c.sql));
    assert.strictEqual(scans.length, 2);
    assert.doesNotMatch(scans[1].sql, /published_config/);
});

// ── test runs ────────────────────────────────────────────────────────
test('recordTestRun inserts, then prunes to the last 20 per skill', async () => {
    const r = await store.recordTestRun({ skillId: 'sk1', agentId: 'a1', question: 'How much?', results: [{ stepId: 's1', title: 'Read', evidence: 'ok', status: 'ok' }], status: 'ok' });
    assert.strictEqual(r.status, 'ok');
    const ins = calls.find(c => /INSERT INTO skill_test_runs/.test(c.sql));
    assert.ok(ins);
    const prune = calls.find(c => /DELETE FROM skill_test_runs/.test(c.sql));
    assert.match(prune.sql, /ORDER BY ran_at DESC LIMIT \$2/);
    assert.deepStrictEqual(prune.params, ['sk1', store.TEST_RUNS_KEEP]);
    assert.strictEqual(store.TEST_RUNS_KEEP, 20);
    // Unknown NARROWS. This used to coerce to 'ok' — the reassuring value on a
    // screen whose only job is to say whether somebody's skill works.
    const bad = await store.recordTestRun({ skillId: 'sk1', status: 'nonsense' });
    assert.strictEqual(bad.status, 'error', 'unknown status is not a pass');
    const none = await store.recordTestRun({ skillId: 'sk1' });
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
