'use strict';

/**
 * The managed-part lock on agents (design 5.2-5.3), against a REAL Postgres
 * (@electric-sql/pglite behind db.js's pool, testUtils/pglitePool.js): the
 * agent store, the project store and the Solution stage store run their own
 * schema and SQL, with no module mocking. An agent is managed when it is
 * filed into a stage project (UAT/PRD).
 *
 * Pinned:
 *   - updateAgent is positional and the route sends every field, so the guard
 *     diffs against the locked row: a prompt change is refused, while an embed
 *     toggle (or a category change) sent with every other field unchanged passes;
 *   - delete, force delete and an owner transfer are refused (a transfer always);
 *   - the tool grants are locked too (assertAgentToolsWrite, the route's gate in
 *     front of agentTools): an unchanged list passes, a changed one is refused;
 *   - publishAgentVersion needs the deploy's capability and runs on the
 *     deploy's own client;
 *   - an unmanaged agent writes as before.
 *
 * Run: cd server && node --test stores/agent/managedLock.pg.test.js
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');

process.env.NODE_ENV = 'test';

const { usePglitePool } = require('../../testUtils/pglitePool');

const { pg, close } = usePglitePool();
const projectStore = require('../projectStore');
const solutionStageStore = require('../solutionStageStore');
const agentSchema = require('./initSchema');
const agents = require('./agentCrud');
const agentTools = require('./agentTools');

const OWNER = 'alice';
let dev;
let uat;
let managedId;
let plainId;

async function refused(promise, message) {
    await assert.rejects(promise, (err) => {
        assert.strictEqual(err.status, 409, message);
        assert.strictEqual(err.code, 'managed_part', message);
        assert.strictEqual(err.details.stage, 'uat');
        return true;
    }, message);
}

const agentRow = async (id) => (await pg.query('SELECT * FROM agents WHERE id = $1', [id])).rows[0];

/** updateAgent with every argument taken from the stored row, as the PUT route sends it. */
async function saveAs(id, over = {}, opts = {}) {
    const r = await agentRow(id);
    const v = {
        name: r.name, description: r.description, systemPrompt: r.system_prompt, model: r.model,
        starterPrompts: JSON.parse(r.starter_prompts || '[]'), avatar: r.avatar,
        threadsEnabled: r.threads_enabled, copyEnabled: r.copy_enabled, workspaceEnabled: r.workspace_enabled,
        config: typeof r.config === 'string' ? JSON.parse(r.config || '{}') : (r.config || {}),
        embedEnabled: r.embed_enabled, organizationId: r.organization_id,
        sharedGroups: JSON.parse(r.shared_groups || '[]'), categoryId: r.category_id,
        ...over,
    };
    return agents.updateAgent(id, v.name, v.description, v.systemPrompt, r.owner_id, v.model, v.starterPrompts,
        v.avatar, v.threadsEnabled, v.copyEnabled, v.workspaceEnabled, v.config, v.embedEnabled,
        v.organizationId, v.sharedGroups, v.categoryId, opts);
}

async function activeDeployment(stageProjectId) {
    const id = `dep-${crypto.randomUUID()}`;
    await pg.query(
        `INSERT INTO solution_deployments (id, solution_id, stage_project_id, stage, release_id, kind, status, plan,
                                           plan_hash, stage_settings_version, request_key, requested_by)
         VALUES ($1, $2, $3, 'uat', 'rel_1', 'deploy', 'committing', '{}'::jsonb, 'h', 1, $1, $4)`,
        [id, dev.id, stageProjectId, OWNER],
    );
    return id;
}

before(async () => {
    await pg.exec(`CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, "organizationId" TEXT)`);
    await projectStore.initDB();
    await solutionStageStore.initDB();
    await agentSchema.initDB();
    dev = await projectStore.createProject({ name: 'Helpdesk', ownerId: OWNER, organizationId: 'org1', kind: 'solution' });
    [uat] = await solutionStageStore.createStages({ devProject: dev, stages: ['uat'], actorId: OWNER });

    const managed = await agents.createAgent('Triage', 'Sorts tickets', 'You sort tickets.', OWNER);
    managedId = managed.id;
    await pg.query('UPDATE agents SET project_id = $1 WHERE id = $2', [uat.projectId, managedId]);
    plainId = (await agents.createAgent('Scratch', '', 'Draft prompt.', OWNER)).id;
});

after(async () => { await close(); });

// ── updateAgent: a diff against the locked row ──────────────────────

test('a prompt change on a managed agent is refused and the row stays as it was', async () => {
    await refused(saveAs(managedId, { systemPrompt: 'You answer tickets yourself.' }));
    const r = await agentRow(managedId);
    assert.strictEqual(r.system_prompt, 'You sort tickets.');
    assert.strictEqual(Number(r.rev), 1, 'a refused save does not bump rev');
});

test('an embed toggle sent with every other field unchanged passes', async () => {
    const result = await saveAs(managedId, { embedEnabled: true });
    assert.strictEqual(result.ok, true);
    assert.strictEqual((await agentRow(managedId)).embed_enabled, true);
});

test('sharing and category may change; a config change may not', async () => {
    assert.strictEqual((await saveAs(managedId, { sharedGroups: ['g1'], categoryId: 'cat1' })).ok, true);
    const r = await agentRow(managedId);
    assert.deepStrictEqual(JSON.parse(r.shared_groups), ['g1']);
    assert.strictEqual(r.category_id, 'cat1');
    await refused(saveAs(managedId, { config: { knowledge_base_ids: ['kb9'] } }));
});

test('the deploy capability lets a full update through', async () => {
    const managedWrite = { deploymentId: await activeDeployment(uat.projectId) };
    assert.strictEqual((await saveAs(managedId, { systemPrompt: 'Release 2 prompt.' }, { managedWrite })).ok, true);
    assert.strictEqual((await agentRow(managedId)).system_prompt, 'Release 2 prompt.');
    await pg.query(`UPDATE solution_deployments SET status = 'succeeded' WHERE id = $1`, [managedWrite.deploymentId]);
});

// ── Tool grants ──────────────────────────────────────────────────────

test('a managed agent\'s tool list may be resent unchanged, never changed without a deploy', async () => {
    // Seeding the grants is a deploy's write: the store refuses it without the capability.
    await refused(agentTools.setAgentTools(managedId, ['web_search', 'mail_send'], { mail_send: { to: 'desk@example.test' } }), 'setAgentTools without a deploy');
    const seedWrite = { deploymentId: await activeDeployment(uat.projectId) };
    await agentTools.setAgentTools(managedId, ['web_search', 'mail_send'], { mail_send: { to: 'desk@example.test' } }, { managedWrite: seedWrite });
    await pg.query(`UPDATE solution_deployments SET status = 'succeeded' WHERE id = $1`, [seedWrite.deploymentId]);
    await refused(agentTools.updateAgentToolParams(managedId, 'mail_send', { to: 'other@example.test' }), 'updateAgentToolParams without a deploy');
    await agentTools.setAgentTools(managedId, ['web_search', 'mail_send'], { mail_send: { to: 'desk@example.test' } });
    const same = [{ componentId: 'mail_send', params: { to: 'desk@example.test' } }, { componentId: 'web_search', params: null }];
    await agents.assertAgentToolsWrite(await agentRow(managedId), same);
    await refused(agents.assertAgentToolsWrite(await agentRow(managedId), [{ componentId: 'web_search' }]), 'a tool dropped');
    await refused(agents.assertAgentToolsWrite(await agentRow(managedId), [...same, { componentId: 'http_request' }]), 'a tool added');
    await refused(agents.assertAgentToolsWrite(await agentRow(managedId), [same[0], { componentId: 'web_search', params: { q: 'x' } }]), 'a fixed param');
    await refused(agents.assertAgentToolsWrite(await agentRow(managedId), (current) => current.map((t) => ({ ...t, params: { q: 'y' } }))), 'params of one tool');
    await agents.assertAgentToolsWrite(await agentRow(managedId), (current) => current);

    const managedWrite = { deploymentId: await activeDeployment(uat.projectId) };
    await agents.assertAgentToolsWrite(await agentRow(managedId), [{ componentId: 'web_search' }], { managedWrite });
    await pg.query(`UPDATE solution_deployments SET status = 'succeeded' WHERE id = $1`, [managedWrite.deploymentId]);
    await agents.assertAgentToolsWrite(await agentRow(plainId), [{ componentId: 'anything' }]);
});

test('the agent GET payload is best-effort: null for an unfiled agent, the stage for a managed one', async () => {
    assert.strictEqual(await agents.managedPayloadOfAgent({ id: plainId, project_id: null }), null);
    const managed = await agents.managedPayloadOfAgent(await agentRow(managedId));
    assert.strictEqual(managed.stage, 'uat');
    assert.strictEqual(await agents.managedPayloadOfAgent({ id: 'x', project_id: { not: 'a string' } }), null);
});

// ── Delete, transfer ─────────────────────────────────────────────────

test('delete and force delete are refused on a managed agent', async () => {
    await refused(agents.deleteAgent(managedId, OWNER));
    await refused(agents.forceDeleteAgent(managedId));
    assert.ok(await agentRow(managedId));
});

test('transferAgentOwner is refused on a managed agent', async () => {
    await refused(agents.transferAgentOwner(managedId, 'bob', null));
    assert.strictEqual((await agentRow(managedId)).owner_id, OWNER);
});

// ── publishAgentVersion ──────────────────────────────────────────────

test('publishAgentVersion without the capability is refused', async () => {
    await refused(agents.publishAgentVersion(managedId));
    assert.strictEqual(Number((await agentRow(managedId)).published_version), 0);
});

test('publishAgentVersion runs on the deploy\'s client with the capability', async () => {
    const managedWrite = { deploymentId: await activeDeployment(uat.projectId) };
    const seen = [];
    const client = { query: (sql, params) => { seen.push(sql); return pg.query(sql, params); } };
    const out = await agents.publishAgentVersion(managedId, { client, managedWrite, config: { tier: 'fast' } });
    assert.strictEqual(out.ok, true);
    assert.strictEqual(out.publishedVersion, 1);
    assert.ok(seen.some((sql) => /UPDATE agents\s+SET published_config/.test(sql)), 'the publish ran on the client');
    assert.ok(seen.some((sql) => /FROM solution_deployments/.test(sql)), 'the capability was checked on the client');
    const r = await agentRow(managedId);
    assert.deepStrictEqual(typeof r.published_config === 'string' ? JSON.parse(r.published_config) : r.published_config, { tier: 'fast' });
    await pg.query(`UPDATE solution_deployments SET status = 'succeeded' WHERE id = $1`, [managedWrite.deploymentId]);
});

// ── Unmanaged ────────────────────────────────────────────────────────

test('an unmanaged agent writes, publishes and transfers as before', async () => {
    assert.strictEqual((await saveAs(plainId, { systemPrompt: 'New prompt.' })).ok, true);
    assert.strictEqual((await agents.publishAgentVersion(plainId)).ok, true);
    assert.strictEqual(await agents.transferAgentOwner(plainId, 'bob', null), true);
    assert.strictEqual(await agents.deleteAgent(plainId, 'bob'), true);
});
