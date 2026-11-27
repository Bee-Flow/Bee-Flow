// @typecheck
/**
 * stores/user/projectErasure.js with the projects module's side of it: the default teardown is
 * projects/projectTeardown.js, and the projects port is the one firstParty/projects.register.js
 * registers. Moved out of projectErasure.test.js, unchanged: both are about the module.
 *
 * Run: cd server && node --test stores/user/projectErasure.projects.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { eraseOwnedProjects } = require('./projectErasure');

test('the default teardown asks the stage question first', () => {
    const { makeProjectTeardown } = require('../../projects/projectTeardown');
    assert.strictEqual(typeof makeProjectTeardown().teardownRefusal, 'function');
});

test('fails closed: with no erasure port registered, owned-project erasure refuses instead of skipping', async () => {
    const { resetErasurePortsForTests, registerErasurePorts } = require('./erasurePorts');
    resetErasurePortsForTests();
    await assert.rejects(
        eraseOwnedProjects('u1', { listOwned: async () => ['p1'], countSharedThreads: async () => 0, handOver: async () => null }),
        /Erasure port 'projects' is not registered/,
    );
    // Registered: the port's teardown is used.
    const tornDown = [];
    registerErasurePorts({ projects: { makeTeardown: () => ({ deleteProject: async (id) => { tornDown.push(id); return true; } }) } });
    const report = await eraseOwnedProjects('u1', { listOwned: async () => ['p1'], countSharedThreads: async () => 0, handOver: async () => null });
    assert.deepStrictEqual(tornDown, ['p1']);
    assert.strictEqual(report.deleted, 1);
    resetErasurePortsForTests();
});
