/**
 * Skills in a Solution stage (design 1.1 E, 5.2, 5.3), against a real Postgres
 * (@electric-sql/pglite behind db.js, testUtils/pglitePool.js): the real
 * skillStore, projectStore and solutionStageStore, nothing mocked. The only
 * swaps are on shared module objects (testUtils/swaps.js): the caller's user
 * row and the GitHub sync config.
 *
 * Pinned:
 *   - a stage skill's sharing changes without a deploy; its content, its
 *     deletion and filing it into or out of a stage need a deployment's
 *     capability (409 managed_part otherwise), judged on what CHANGES, so a
 *     full-snapshot save that only flips sharing goes through;
 *   - writeManagedSkill writes on the caller's transaction: it rolls back
 *     with it, and a deployment admitted in the same transaction counts;
 *   - a stage skill never becomes a pending GitHub sync change;
 *   - GET /api/skills/:id carries `managed`, and the PUT answers the store's
 *     409 instead of a 500.
 *
 * Run: cd server && node --test stores/skillStore.managed.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const { test, before, after } = require('node:test');
const assert = require('node:assert');

const { usePglitePool } = require('../testUtils/pglitePool');
const { makeSwaps } = require('../testUtils/swaps');

const { close } = usePglitePool();
const db = require('../db');
const projectStore = require('./projectStore');
const solutionStageStore = require('./solutionStageStore');
const skillStore = require('./skillStore');
const userStore = require('./userStore');
const h = require('../core/http/routeHarness');

const { swap, restore } = makeSwaps();

let dev;
let uat;
let deployment;
let api;

const ALICE = { id: 'alice', organizationId: 'org1', role: 'user', email: 'alice@example.test' };
const isManaged = (err) => err?.status === 409 && err.code === 'managed_part' && err.details?.stage === 'uat';
const cap = () => ({ deploymentId: deployment.id });

before(async () => {
    swap(userStore, 'getUser', async (id) => ({ id, organizationId: 'org1', groups: [] }));
    await projectStore.initDB();
    await solutionStageStore.initDB();
    await skillStore.initDB();
    dev = await projectStore.createProject({ name: 'Invoices', ownerId: 'alice', organizationId: 'org1', kind: 'solution' });
    [uat] = await solutionStageStore.createStages({ devProject: dev, stages: ['uat'], actorId: 'alice' });
    deployment = await solutionStageStore.insertDeployment({
        solutionId: dev.id, stageProjectId: uat.projectId, stage: 'uat', kind: 'deploy', releaseId: 'rel-1',
        status: 'queued', plan: {}, planHash: 'h1', stageSettingsVersion: 1, requestKey: 'k1', requestedBy: 'alice',
    });
    h.openGates();
    api = h.serve('/api/skills', require('../routes/skills'), { user: ALICE });
});

after(async () => {
    restore();
    if (api) await api.close();
    // The structured-fields backfill skillStore schedules at init must not
    // outlive the database it reads.
    await new Promise((r) => setTimeout(r, 50));
    await close();
});

/** A stage skill, written the way a deploy writes it. */
async function deployedSkill(fields = {}) {
    return db.withTransaction((client) => skillStore.writeManagedSkill(client, {
        ownerId: 'alice', orgId: 'org1', projectId: uat.projectId, managedWrite: cap(),
        fields: { name: 'Invoice tone', instructions: 'Be brief.', ...fields },
    }));
}

// ── writeManagedSkill ────────────────────────────────────────────────

test('writeManagedSkill refuses a write without a deployment of that stage', async () => {
    await assert.rejects(db.withTransaction((client) => skillStore.writeManagedSkill(client, {
        ownerId: 'alice', orgId: 'org1', projectId: uat.projectId, managedWrite: null, fields: { name: 'x' },
    })), isManaged);
    await assert.rejects(db.withTransaction((client) => skillStore.writeManagedSkill(client, {
        ownerId: 'alice', orgId: 'org1', projectId: uat.projectId, managedWrite: { deploymentId: 'dep-unknown' }, fields: { name: 'x' },
    })), isManaged);
});

test('writeManagedSkill writes on the caller\'s transaction and rolls back with it', async () => {
    let id = null;
    await assert.rejects(db.withTransaction(async (client) => {
        const row = await skillStore.writeManagedSkill(client, {
            ownerId: 'alice', orgId: 'org1', projectId: uat.projectId, managedWrite: cap(), fields: { name: 'Rolled back' },
        });
        id = row.id;
        throw new Error('the deploy failed later in its commit');
    }), /failed later/);
    assert.ok(id);
    assert.strictEqual((await db.getOne('SELECT 1 AS x FROM skills WHERE id = $1', [id])), null);
});

test('a deployment admitted in the same transaction is a valid capability', async () => {
    const pending = await db.getOne('SELECT id FROM solution_deployments WHERE id = $1', ['dep-same-tx']);
    assert.strictEqual(pending, null);
    await assert.rejects(db.withTransaction(async (client) => {
        // One active deployment per stage: park the admitted one, then admit
        // a second that exists only inside this transaction.
        await client.query(`UPDATE solution_deployments SET status = 'succeeded' WHERE id = $1`, [deployment.id]);
        await client.query(
            `INSERT INTO solution_deployments (id, solution_id, stage_project_id, stage, release_id, kind, status, plan,
                plan_hash, stage_settings_version, request_key, requested_by)
             VALUES ('dep-same-tx', $1, $2, 'uat', 'rel-2', 'deploy', 'committing', '{}'::jsonb, 'h2', 1, 'k-same', 'alice')`,
            [dev.id, uat.projectId],
        );
        const row = await skillStore.writeManagedSkill(client, {
            ownerId: 'alice', orgId: 'org1', projectId: uat.projectId, managedWrite: { deploymentId: 'dep-same-tx' }, fields: { name: 'Same tx' },
        });
        assert.strictEqual(row.projectId, uat.projectId);
        throw new Error('roll the probe back');
    }), /roll the probe back/);
    assert.strictEqual((await solutionStageStore.getDeployment(deployment.id)).status, 'queued');
});

test('writeManagedSkill inserts an unshared stage skill owned by run-as, then updates it in place', async () => {
    const first = await deployedSkill({ steps: [{ id: 's1', text: 'Read the invoice' }] });
    assert.strictEqual(first.projectId, uat.projectId);
    assert.strictEqual(first.userId, 'alice');
    assert.strictEqual(first.isShared, false);
    assert.strictEqual(first.version, 1);
    assert.match(first.workflow, /Read the invoice/);

    const second = await db.withTransaction((client) => skillStore.writeManagedSkill(client, {
        id: first.id, ownerId: 'alice', orgId: 'org1', projectId: uat.projectId, managedWrite: cap(),
        fields: { name: 'Invoice tone v2' },
    }));
    assert.strictEqual(second.id, first.id);
    assert.strictEqual(second.name, 'Invoice tone v2');
    assert.strictEqual(second.instructions, 'Be brief.', 'a field left out keeps its value');
    assert.strictEqual(second.version, 2);

    // An id that lives in another project is never taken over.
    const plain = await skillStore.createSkill({ orgId: 'org1', userId: 'alice', name: 'Plain' });
    await assert.rejects(db.withTransaction((client) => skillStore.writeManagedSkill(client, {
        id: plain.id, ownerId: 'alice', orgId: 'org1', projectId: uat.projectId, managedWrite: cap(), fields: { name: 'x' },
    })), (e) => e.status === 409 && e.code === 'skill_not_in_stage');
});

// ── The guard on updateSkill / deleteSkill ───────────────────────────

test('a stage skill shares without a deploy; its content needs one', async () => {
    const skill = await deployedSkill();
    await assert.rejects(skillStore.updateSkill(skill.id, 'alice', { name: 'Edited on the stage' }), isManaged);
    await assert.rejects(skillStore.updateSkill(skill.id, 'alice', { instructions: 'Something else' }), isManaged);

    // Sharing is the stage's own.
    assert.strictEqual(await skillStore.updateSkill(skill.id, 'alice', { isShared: true, sharedGroups: ['g1'] }), true);
    // A full snapshot (mobile, the Studio autosave) that only flips sharing.
    assert.strictEqual(await skillStore.updateSkill(skill.id, 'alice', {
        name: skill.name, description: skill.description, instructions: skill.instructions,
        workflow: skill.workflow, rules: skill.rules, examples: skill.examples, icon: skill.icon, isShared: false,
    }), true);
    const after1 = (await skillStore.getAvailableSkills('org1', 'alice')).find((s) => s.id === skill.id);
    assert.strictEqual(after1.name, 'Invoice tone');
    assert.strictEqual(after1.isShared, false);
    assert.deepStrictEqual(after1.sharedGroups, ['g1']);

    // A deploy may.
    assert.strictEqual(await skillStore.updateSkill(skill.id, 'alice', { name: 'Through a deploy' }, { managedWrite: cap() }), true);
});

test('the Studio autosave (structured facets read back from JSONB) that only flips sharing goes through', async () => {
    const skill = await deployedSkill({
        steps: [{ id: 's1', text: 'Read the invoice' }],
        rulesV2: [{ id: 'r1', text: 'Never guess an amount' }],
        outputSchema: { type: 'object', properties: { total: { type: 'number' } } },
    });
    // JSONB hands object keys back in its own order ({id, refs, text}); the
    // Studio sends exactly that back, alongside every other facet.
    const full = await skillStore.getSkill(skill.id, 'org1', 'alice');
    const payload = {
        name: full.name, description: full.description, instructions: full.instructions, icon: full.icon,
        isShared: !full.isShared, dynamicActivation: !!full.dynamicActivation,
        sharedGroups: full.sharedGroups || [], enabledIntegrations: full.enabledIntegrations || [],
        steps: full.steps, rulesV2: full.rulesV2, examplesV2: full.examplesV2, outputSchema: full.outputSchema ?? null,
        knowledgeBaseIds: full.knowledgeBaseIds || [], allowedAutomationIds: full.allowedAutomationIds || [],
    };
    assert.strictEqual(await skillStore.updateSkill(skill.id, 'alice', { steps: full.steps }), true, 'unchanged steps alone');
    assert.strictEqual(await skillStore.updateSkill(skill.id, 'alice', { rulesV2: full.rulesV2 }), true, 'unchanged rules alone');
    assert.strictEqual(await skillStore.updateSkill(skill.id, 'alice', payload), true, 'the whole Studio payload');
    const after1 = await skillStore.getSkill(skill.id, 'org1', 'alice');
    assert.strictEqual(after1.isShared, true);
    assert.strictEqual(after1.version, full.version, 'a save that changes nothing but sharing bumps no version');
    // A real change in a structured facet is still refused.
    await assert.rejects(skillStore.updateSkill(skill.id, 'alice', {
        ...payload, steps: [...full.steps, { id: 's2', text: 'Book it' }],
    }), isManaged);
});

test('a stage skill is deleted only by a deploy, and a stranger still reads "not found"', async () => {
    const skill = await deployedSkill();
    await assert.rejects(skillStore.deleteSkill(skill.id, 'alice'), isManaged);
    assert.strictEqual(await skillStore.deleteSkill(skill.id, 'mallory'), false, 'not theirs: a plain false, no stage named');
    assert.strictEqual(await skillStore.deleteSkill(skill.id, 'alice', false, { managedWrite: cap() }), true);
});

test('an ordinary skill is not slowed down or refused by the guard', async () => {
    const skill = await skillStore.createSkill({ orgId: 'org1', userId: 'alice', name: 'Free' });
    assert.strictEqual(await skillStore.updateSkill(skill.id, 'alice', { name: 'Free 2' }), true);
    assert.strictEqual(await skillStore.deleteSkill(skill.id, 'alice'), true);
});

// ── Projects ─────────────────────────────────────────────────────────

test('filing into or out of a stage needs a deploy; Dev is ordinary', async () => {
    const skill = await skillStore.createSkill({ orgId: 'org1', userId: 'alice', name: 'Filed' });
    await assert.rejects(skillStore.setSkillProject(skill.id, 'alice', uat.projectId), isManaged);
    assert.strictEqual(await skillStore.setSkillProject(skill.id, 'alice', dev.id), true);
    assert.strictEqual(await skillStore.setSkillProject(skill.id, 'bob', null), false, 'owner only');

    const listed = await skillStore.listProjectSkills(dev.id);
    assert.deepStrictEqual(listed.map((s) => [s.id, s.ownerId, s.projectId]), [[skill.id, 'alice', dev.id]]);
    assert.ok(!('instructions' in listed[0]), 'a narrow projection');
    const counts = await skillStore.countProjectSkills([dev.id, uat.projectId, 'nope']);
    assert.strictEqual(counts.get(dev.id), 1);

    const staged = await deployedSkill();
    await assert.rejects(skillStore.setSkillProject(staged.id, 'alice', null), isManaged);
    await assert.rejects(skillStore.setSkillProject(staged.id, 'alice', dev.id), isManaged);
    await assert.rejects(skillStore.clearProjectFromSkills(uat.projectId), isManaged);
    assert.ok((await skillStore.countProjectSkills([uat.projectId])).get(uat.projectId) >= 1);

    assert.strictEqual(await skillStore.clearProjectFromSkills(dev.id), 1);
    assert.ok(await skillStore.clearProjectFromSkills(uat.projectId, { managedWrite: cap() }) >= 1);
    assert.strictEqual((await skillStore.countProjectSkills([uat.projectId])).get(uat.projectId), undefined);
});

// ── GitHub sync ──────────────────────────────────────────────────────

test('a stage skill never becomes a pending GitHub sync change', async (t) => {
    const local = makeSwaps();
    t.after(local.restore);
    const asked = [];
    local.swap(require('./githubSyncStore'), 'getOrgSyncConfig', async (orgId) => { asked.push(orgId); return null; });

    await skillStore._notifySkillSync('org1', 'skill-on-stage', 'pending', uat.projectId);
    assert.deepStrictEqual(asked, [], 'skipped for a stage skill');
    await skillStore._notifySkillSync('org1', 'skill-in-dev', 'pending', dev.id);
    await skillStore._notifySkillSync('org1', 'skill-loose', 'pending', null);
    assert.deepStrictEqual(asked, ['org1', 'org1'], 'Dev and loose skills still sync');
});

// ── The route ────────────────────────────────────────────────────────

test('GET /api/skills/:id carries `managed`; a PUT that the store refuses answers 409', async () => {
    const staged = await deployedSkill();
    const plain = await skillStore.createSkill({ orgId: 'org1', userId: 'alice', name: 'Plain read' });

    const a = await api.call('GET', `/api/skills/${staged.id}`);
    assert.strictEqual(a.status, 200, a.text);
    assert.deepStrictEqual(a.body.managed, {
        solutionId: dev.id, solutionName: 'Invoices', stage: 'uat', releaseSeq: null, devRef: null,
    });
    const b = await api.call('GET', `/api/skills/${plain.id}`);
    assert.strictEqual(b.status, 200, b.text);
    assert.strictEqual(b.body.managed, null);

    const put = await api.call('PUT', `/api/skills/${staged.id}`, { body: { name: 'Edited on the stage' } });
    assert.strictEqual(put.status, 409, put.text);
    assert.strictEqual(put.body.code, 'managed_part');
    const share = await api.call('PUT', `/api/skills/${staged.id}`, { body: { isShared: true } });
    assert.strictEqual(share.status, 200, share.text);
});

test('the AI rewrite and an example from a message answer the stage refusal, not a 500', async () => {
    const staged = await deployedSkill();
    const improve = await api.call('POST', `/api/skills/${staged.id}/ai/improve`, { body: { note: 'shorter' } });
    assert.strictEqual(improve.status, 409, improve.text);
    assert.strictEqual(improve.body.code, 'managed_part');
    const example = await api.call('POST', `/api/skills/${staged.id}/examples/from-message`, {
        body: { conversationId: 'conv-1', messageIndex: 0 },
    });
    assert.strictEqual(example.status, 409, example.text);
    assert.strictEqual(example.body.code, 'managed_part');
    assert.strictEqual((await skillStore.getSkill(staged.id, 'org1', 'alice')).version, staged.version, 'nothing was written');
});
