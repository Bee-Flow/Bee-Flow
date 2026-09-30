/**
 * routes/projects/memberColors.js over a real Express app (core/http/routeHarness) with the real
 * store over PGlite and a fake role gate and feed.
 *
 * Run: cd server && node --test routes/projects/memberColors.test.js
 */

'use strict';

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const { serve } = require('../../core/http/routeHarness');
const { pgliteDb } = require('../../testUtils/pgliteDb');
const { fakeRequireProjectRole } = require('../../testUtils/projectRoleGate');
const storeModule = require('../../stores/projectMemberColorStore');
const { makeMemberColorsRouter } = require('./memberColors');

const who = (id) => ({ id, organizationId: 'org1', role: 'user' });
const OWNER = who('olga');
const EDITOR = who('ed');
const VIEWER = who('vic');
const STRANGER = who('sam');
const ROLES = { p1: { olga: 'owner', ed: 'editor', vic: 'viewer' } };
const SHARES = [
    { sharedWithType: 'user', sharedWithId: 'ed' },
    { sharedWithType: 'user', sharedWithId: 'vic' },
    { sharedWithType: 'group', sharedWithId: 'g1' },
];

const { pg, db } = pgliteDb();
const store = storeModule.makeProjectMemberColorStore(db);
let events;

const requireProjectRole = fakeRequireProjectRole(ROLES);

const api = serve('/api/projects', makeMemberColorsRouter({
    requireProjectRole,
    getProject: async (id) => (id === 'p1' ? { id: 'p1', ownerId: 'olga' } : null),
    getShares: async () => SHARES,
    store,
    emit: async (projectId, event) => { events.push({ projectId, ...event }); },
}), { user: EDITOR });

before(async () => {
    await pg.exec('CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, owner_id TEXT NOT NULL)');
    await pg.exec(storeModule.DDL);
    await pg.query(`INSERT INTO projects (id, name, owner_id) VALUES ('p1', 'p1', 'olga')`);
});
after(async () => { await api.close(); await pg.close(); });
beforeEach(() => { events = []; });

const put = (who_, target, body) => api.call('PUT', `/api/projects/p1/members/${target}/color`, { body, user: who_ });

test('a person sets their own colour, and everybody on the project can', async () => {
    for (const [user, id] of [[EDITOR, 'ed'], [VIEWER, 'vic'], [OWNER, 'olga']]) {
        const res = await put(user, id, { color: '#3b82f6' });
        assert.strictEqual(res.status, 200, res.text);
        assert.deepStrictEqual(res.body, { userId: id, color: '#3b82f6' });
    }
    assert.deepStrictEqual(await store.listColors('p1'), { ed: '#3b82f6', vic: '#3b82f6', olga: '#3b82f6' });
});

test('only the owner gives somebody else a colour', async () => {
    const other = await put(EDITOR, 'vic', { color: '#22c55e' });
    assert.strictEqual(other.status, 403);
    assert.strictEqual(other.body.code, 'not_your_colour');
    assert.strictEqual((await put(OWNER, 'vic', { color: '#22c55e' })).status, 200);
    assert.strictEqual((await store.listColors('p1')).vic, '#22c55e');
});

test('the colour is one of the fixed hues, in any case, or null for the automatic one', async () => {
    for (const bad of ['red', '#ffffff', '#3b82f6; background:url(x)', 'javascript:1', '']) {
        assert.strictEqual((await put(EDITOR, 'ed', { color: bad })).status, 400, bad);
    }
    assert.strictEqual((await put(EDITOR, 'ed', { color: '#F43F5E' })).body.color, '#f43f5e');
    assert.strictEqual((await put(EDITOR, 'ed', { color: null })).body.color, null);
    assert.strictEqual((await store.listColors('p1')).ed, undefined);
    assert.strictEqual((await put(EDITOR, 'ed', { colour: '#3b82f6' })).status, 400, 'a closed body');
});

test('only people of the project, and only with a role', async () => {
    assert.strictEqual((await put(OWNER, 'sam', { color: '#3b82f6' })).status, 404, 'not on the project');
    assert.strictEqual((await put(STRANGER, 'sam', { color: '#3b82f6' })).status, 404, 'no role');
    assert.strictEqual((await api.call('PUT', '/api/projects/p1/members/ed/color', { body: { color: '#3b82f6' }, user: null })).status, 401);
});

test('the live feed says who changed, and nothing else', async () => {
    await put(EDITOR, 'ed', { color: '#14b8a6' });
    assert.deepStrictEqual(events, [{ projectId: 'p1', kind: 'member_color', actorId: 'ed', targetType: 'user', targetId: 'ed', payload: { userId: 'ed' } }]);
});
