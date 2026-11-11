'use strict';

/**
 * Arming after a Solution stage wrote the published copy (triggers/deploySync.mts), against the
 * REAL trigger store on PGlite (testUtils/triggerHarness.testkit.js): a deploy arms, updates and
 * removes rows as a publish does, only from the published copy, only for an active owner with
 * App Studio, and two deploys at once leave one set.
 *
 * Run: cd server && node --test appStudio/triggers/deploySync.test.js
 */

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { triggerHarness } = require('../../testUtils/triggerHarness.testkit');
const { syncAfterStageChange } = require('./deploySync.mts');

const h = triggerHarness({ before, after, beforeEach });
const { t, rows, row, definition, every } = h;

const ids = async () => (await rows()).map((r) => [r.triggerId, r.config.schedule.everyMinutes]);
/** What a deploy's commit writes: the published copy (and its version), without the publish route's sync. */
function deployCopy(def, { published = true } = {}) {
    Object.assign(t.app, { isPublished: published, publishedDefinition: def, publishedVersion: (t.app.publishedVersion || 0) + 1 });
}
const syncAfterDeploy = () => syncAfterStageChange('app_1', { readers: h.identity(), sync: h.syncDeps() });

test('a deploy of a published app arms its triggers, as a publish does', async () => {
    deployCopy(definition([every(15)]));
    assert.deepEqual(await syncAfterDeploy(), { synced: { armed: 1, updated: 0, kept: 0, removed: 0 } });
    const armed = await row();
    assert.deepEqual([armed.state, armed.ownerUserId, armed.actionId], ['armed', 'owner', 'act_job']);
});

test('a later deploy updates a changed trigger, adds a new one and removes one that left; the same deploy again keeps them', async () => {
    deployCopy(definition([every(15), every(60, { id: 'hourly' })]));
    await syncAfterDeploy();
    deployCopy(definition([every(30), every(5, { id: 'often' })]));
    assert.deepEqual(await syncAfterDeploy(), { synced: { armed: 1, updated: 1, kept: 0, removed: 1 } });
    assert.deepEqual(await ids(), [['often', 5], ['tick', 30]]);
    assert.deepEqual(await syncAfterDeploy(), { synced: { armed: 0, updated: 0, kept: 2, removed: 0 } });
});

test('two instances that converge the same deploy at once leave one consistent set', async () => {
    deployCopy(definition([every(15), every(60, { id: 'hourly' })]));
    await syncAfterDeploy();
    deployCopy(definition([every(30), every(5, { id: 'often' })]));
    const [a, b] = await Promise.all([syncAfterDeploy(), syncAfterDeploy()]);
    assert.deepEqual([a.synced.armed + b.synced.armed, a.synced.updated + b.synced.updated, a.synced.removed + b.synced.removed], [1, 1, 1], 'each change is made once');
    assert.deepEqual(await ids(), [['often', 5], ['tick', 30]]);
});

test('only the published copy arms: a draft or a prepared working copy adds nothing', async () => {
    deployCopy(definition([every(15)]));
    await syncAfterDeploy();
    // A prepare (or a draft save, a template install, a version restore) writes the working copy only.
    t.app.definition = definition([every(15), every(5, { id: 'draft_only' })]);
    assert.deepEqual(await syncAfterDeploy(), { synced: { armed: 0, updated: 0, kept: 1, removed: 0 } });
    assert.deepEqual(await ids(), [['tick', 15]]);
});

test('a deployed copy of an app that is not published arms nothing, and a retire (unpublish) removes the rows', async () => {
    deployCopy(definition([every(15)]), { published: false });
    assert.deepEqual(await syncAfterDeploy(), { synced: { armed: 0, updated: 0, kept: 0, removed: 0 } });
    deployCopy(definition([every(15)]));
    await syncAfterDeploy();
    t.app.isPublished = false;
    t.owner.status = 'deactivated';
    assert.deepEqual(await syncAfterDeploy(), { synced: { armed: 0, updated: 0, kept: 0, removed: 1 } }, 'removing needs no active owner');
    assert.deepEqual(await rows(), []);
});

test('an owner who is not active, or has no App Studio, gets nothing armed and keeps the rows as they were', async () => {
    deployCopy(definition([every(15)]));
    await syncAfterDeploy();
    const before = await rows();
    deployCopy(definition([every(30), every(5, { id: 'often' })]));
    t.owner.status = 'deactivated';
    assert.deepEqual(await syncAfterDeploy(), { skipped: 'owner_inactive' });
    t.owner.status = 'active';
    t.capability = false;
    assert.deepEqual(await syncAfterDeploy(), { skipped: 'capability_off' });
    assert.deepEqual(await rows(), before);
});

test('a reader that fails answers synced: null (the converge tries again)', async () => {
    deployCopy(definition([every(15)]));
    const readers = { ...h.identity(), getApp: async () => { throw new Error('db down'); } };
    assert.deepEqual(await syncAfterStageChange('app_1', { readers, sync: h.syncDeps() }), { synced: null });
    assert.deepEqual(await rows(), []);
});
