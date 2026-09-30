'use strict';

/**
 * Who may file a NEW meeting note into a project at upload time
 * (projects/meetingFiling.js), with every collaborator injected:
 * no module mocking and no database. The REAL membership registry decides
 * which containers hold meeting notes.
 *
 * Run: cd server && node --test projects/meetingFiling.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const membership = require('./membership');
const { makeMeetingFiling } = require('./meetingFiling');

const ROLES = {
    ws: { owner: 'owner', ed: 'editor', view: 'viewer' },
    legacy: { ed: 'editor' },
    sol: { ed: 'editor' },
    foreign: { ed: 'editor' },
    vanished: { ed: 'editor' },
};
const PROJECTS = {
    ws: { id: 'ws', kind: 'workspace', organizationId: 'org1' },
    legacy: { id: 'legacy', kind: null, organizationId: 'org1' },
    sol: { id: 'sol', kind: 'solution', organizationId: 'org1' },
    foreign: { id: 'foreign', kind: 'workspace', organizationId: 'org2' },
};

function build(over = {}) {
    const rec = { activity: [], events: [], errors: [] };
    const target = makeMeetingFiling({
        getProjectRole: async (userId, projectId) => ROLES[projectId]?.[userId] || null,
        getProject: async (id) => PROJECTS[id] || null,
        membership,
        logActivity: async (...a) => { rec.activity.push(a); },
        emitProjectEvent: async (projectId, event) => { rec.events.push({ projectId, ...event }); },
        log: { error: (...a) => rec.errors.push(a.join(' ')), warn: (...a) => rec.errors.push(a.join(' ')) },
        ...over,
    });
    return { target, rec };
}

test('an editor or the owner files into a workspace, and into a legacy project', async () => {
    const { target } = build();
    assert.deepStrictEqual(await target.resolve('ed', 'org1', 'ws'), { ok: true, projectId: 'ws' });
    assert.deepStrictEqual(await target.resolve('owner', 'org1', 'ws'), { ok: true, projectId: 'ws' });
    assert.deepStrictEqual(await target.resolve('ed', 'org1', 'legacy'), { ok: true, projectId: 'legacy' });
});

test('a stranger gets 404 and a viewer 403', async () => {
    const { target } = build();
    const stranger = await target.resolve('nobody', 'org1', 'ws');
    assert.strictEqual(stranger.ok, false);
    assert.strictEqual(stranger.status, 404);
    assert.strictEqual((await target.resolve('ed', 'org1', 'no-such-project')).status, 404);
    const viewer = await target.resolve('view', 'org1', 'ws');
    assert.strictEqual(viewer.status, 403);
    assert.match(viewer.error, /editors/);
});

test('a Studio Solution holds no meeting notes', async () => {
    const { target } = build();
    const res = await target.resolve('ed', 'org1', 'sol');
    assert.strictEqual(res.status, 409);
    assert.strictEqual(res.code, 'KIND_NOT_ALLOWED');
});

test('a note is never filed into another organisation\'s project', async () => {
    const { target } = build();
    const res = await target.resolve('ed', 'org1', 'foreign');
    assert.strictEqual(res.status, 409);
    assert.strictEqual(res.code, 'project_org_mismatch');
    // An empty organisation matches only an empty one.
    assert.strictEqual((await target.resolve('ed', null, 'ws')).code, 'project_org_mismatch');
});

test('a project that vanished after the role check is a 404', async () => {
    const { target } = build();
    assert.strictEqual((await target.resolve('ed', 'org1', 'vanished')).status, 404);
});

test('announce writes the activity row and the live event, with ids only', async () => {
    const { target, rec } = build();
    await target.announce('ws', 'ed', 'm1');
    assert.deepStrictEqual(rec.activity, [['ws', 'ed', 'resource_added', { targetType: 'meeting', targetId: 'm1' }]]);
    assert.deepStrictEqual(rec.events, [{
        projectId: 'ws', kind: 'resource_added', actorId: 'ed', targetType: 'meeting', targetId: 'm1',
        payload: { targetType: 'meeting', targetId: 'm1' },
    }]);
});

test('announce never throws: the upload was already accepted', async () => {
    const { target, rec } = build({
        logActivity: async () => { throw new Error('activity table is down'); },
        emitProjectEvent: async () => { throw new Error('bus is down'); },
    });
    await target.announce('ws', 'ed', 'm1');
    assert.strictEqual(rec.errors.length, 2, 'both failures are logged');
});
