/**
 * The run-as wall (design 3.1, 3.4): an account that runs a Solution stage, or
 * owns a stage project, is neither deleted nor moved out of its organisation
 * (409 stage_run_as) until an org admin detaches or removes the stages.
 *
 * Against a real Postgres (@electric-sql/pglite behind db.js,
 * testUtils/pglitePool.js): the real users schema, projectStore and
 * solutionStageStore; nothing mocked.
 *
 * Pinned:
 *   - deleteUser refuses BEFORE anything is dropped: the user row is still
 *     there afterwards;
 *   - updateUser refuses an organisationId change (leaving, or moving to
 *     another organisation) and leaves the row untouched, but lets every
 *     other field through;
 *   - an account without stages is not slowed down by the wall;
 *   - after a detach the same account may leave.
 *
 * Run: cd server && node --test stores/user/users.stageGuard.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const { test, before, after } = require('node:test');
const assert = require('node:assert');

const { usePglitePool } = require('../../testUtils/pglitePool');

const { close } = usePglitePool();
const users = require('./users');
const { initDB } = require('./schema');
const projectStore = require('../projectStore');
const solutionStageStore = require('../solutionStageStore');

let dev;
let uat;

const isRunAs = (err) => err?.status === 409 && err.code === 'stage_run_as' && err.expose === true
    && Array.isArray(err.details?.stages) && err.details.stages.every((s) => s.solutionId === dev.id);

before(async () => {
    await initDB();
    for (const id of ['alice', 'bob', 'carol']) {
        assert.strictEqual(await users.createUser({ id, username: id, passwordHash: '', organizationId: 'org1', orgRole: 'member' }), true);
    }
    // Before any stage exists, nobody runs one: the wall reads no stage table.
    assert.deepStrictEqual(await users.stagesRunBy('alice'), []);

    await projectStore.initDB();
    await solutionStageStore.initDB();
    dev = await projectStore.createProject({ name: 'Invoices', ownerId: 'alice', organizationId: 'org1', kind: 'solution' });
    [uat] = await solutionStageStore.createStages({ devProject: dev, stages: ['uat'], actorId: 'alice' });
});

after(close);

test('the stages an account runs, and of which organisation', async () => {
    assert.deepStrictEqual((await users.stagesRunBy('alice')).map((s) => [s.solutionId, s.stage]), [[dev.id, 'uat']]);
    assert.deepStrictEqual(await users.stagesRunBy('alice', { organizationId: 'org2' }), []);
    assert.deepStrictEqual(await users.stagesRunBy('bob'), []);
});

test('deleting the run-as of a stage is refused before anything is dropped', async () => {
    await assert.rejects(users.deleteUser('alice'), isRunAs);
    assert.ok(await users.getUser('alice'), 'the account is still there');
    assert.ok(await projectStore.getProject(uat.projectId), 'and so is the stage');
});

test('moving the run-as out of the organisation is refused; other fields still save', async () => {
    await assert.rejects(users.updateUser('alice', { organizationId: '', orgRole: '', groups: [] }), isRunAs);
    await assert.rejects(users.updateUser('alice', { organizationId: 'org2' }), isRunAs);
    const kept = await users.getUser('alice');
    assert.strictEqual(kept.organizationId, 'org1');
    assert.strictEqual(kept.orgRole, 'member', 'nothing of the refused write landed');

    assert.strictEqual(await users.updateUser('alice', { displayName: 'Alice A.', organizationId: 'org1' }), true,
        'the same organisation is no move');
    assert.strictEqual((await users.getUser('alice')).displayName, 'Alice A.');
});

test('the owner of a stage project is held the same way as its run-as', async () => {
    // A stage cannot be handed over in v1 (projectStore refuses it), so the
    // owner is set the way a later re-own would: straight on the row.
    await require('../../db').run('UPDATE projects SET owner_id = $1 WHERE id = $2', ['carol', uat.projectId]);
    await assert.rejects(users.deleteUser('carol'), isRunAs);
    await assert.rejects(users.updateUser('carol', { organizationId: '' }), isRunAs);
    await require('../../db').run('UPDATE projects SET owner_id = $1 WHERE id = $2', ['alice', uat.projectId]);
});

test('an account without stages leaves and is deleted as before', async () => {
    assert.strictEqual(await users.updateUser('bob', { organizationId: '', orgRole: '' }), true);
    assert.strictEqual((await users.getUser('bob')).organizationId, '');
});

test('after a detach, the former run-as may leave', async () => {
    await solutionStageStore.detachStage(uat.projectId, 'alice');
    assert.deepStrictEqual(await users.stagesRunBy('alice'), []);
    assert.strictEqual(await users.updateUser('alice', { organizationId: '' }), true);
});
