/**
 * What the project routes accept (routes/projects.js, routes/projects/schemas.js).
 *
 *   - `attach: "false"` on PUT /:id/resources filed the resource INTO the
 *     project. Now "false" means false, and anything else that is not a
 *     boolean is a 400.
 *   - a misspelled or missing role on PUT /:id/members/:memberId became
 *     `viewer` under a 200: an editor was demoted by a typo.
 *   - `?offset=-5` reached SQL and came back a 500.
 *   - PUT {"name": ""} blanked the project's name.
 *   - a misspelled key was ignored under a 200.
 *
 * No refused request reaches the database; the role gate still runs first.
 *
 * Run: cd server && node --test routes/projects.validation.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const h = require('../core/http/routeHarness');

const { db, api } = h.routeUnderTest(test, '/api/projects', () => {
    // The project role ladder is its own tested module (auth/projectAccess.test.js);
    // here every caller with a session is the owner, so what is left is the schema.
    require('../auth/projectAccess').requireProjectRole = () => function requireProjectRoleMw(req, res, next) {
        if (!req.session?.user) return res.status(401).json({ error: 'Not authenticated' });
        req.projectRole = 'owner';
        return next();
    };
    require('../license/middleware').requireFeature = () => (req, res, next) => next();
    return require('./projects');
});

test('attach "false" means take it out; any other text is refused', async () => {
    h.assertRefused(assert, await api.call('PUT', '/api/projects/p1/resources', {
        body: { kind: 'notebook', id: 'nb1', attach: 'no' },
    }), 'body.attach', /attach is true \(file in\) or false \(take out\)/);
    assert.deepStrictEqual(db.queries, []);

    const res = await api.call('PUT', '/api/projects/p1/resources', {
        body: { kind: 'notebook', id: 'nb1', attach: 'false' },
    });
    // No such notebook in the recording database: the move reaches the store
    // and matches nothing. What matters is which way it was asked to move.
    assert.strictEqual(res.status, 404, res.text);
    const move = db.queries.find((q) => /UPDATE\s+notebooks/i.test(q));
    assert.ok(move, `the store was asked to move the notebook: ${db.queries.join(' | ')}`);
});

test('a role the ladder does not have is refused, not turned into viewer', async () => {
    for (const body of [{ role: 'edtor' }, { role: 'owner' }, {}]) {
        h.assertRefused(assert, await api.call('PUT', '/api/projects/p1/members/s1', { body }), 'body.role', /role must be viewer or editor/);
    }
    h.assertRefused(assert, await api.call('POST', '/api/projects/p1/share', {
        body: { sharedWithType: 'user', sharedWithId: 'carol', permission: 'admin' },
    }), 'body.permission', /permission must be viewer or editor/);
    h.assertRefused(assert, await api.call('POST', '/api/projects/p1/share', {
        body: { sharedWithType: 'team', sharedWithId: 'carol' },
    }), 'body.sharedWithType', /sharedWithType must be user or group/);
    assert.deepStrictEqual(db.queries, []);
});

test('a page position that is not a whole number of 0 or more is refused', async () => {
    for (const qs of ['?offset=-5', '?limit=abc', '?limt=5']) {
        const res = await api.call('GET', `/api/projects/p1/activity${qs}`);
        assert.strictEqual(res.status, 400, `${qs}: ${res.text}`);
    }
    h.assertRefused(assert, await api.call('GET', '/api/projects/p1/threads?offset=-1'), 'query.offset', /offset is a whole number/);
    assert.deepStrictEqual(db.queries, []);
});

test('a blank name, a misspelled key and a list that is not a list are refused', async () => {
    h.assertRefused(assert, await api.call('PUT', '/api/projects/p1', { body: { name: '  ' } }), 'body.name', /Name is required/);
    h.assertRefused(assert, await api.call('PUT', '/api/projects/p1', { body: { custom_instructions: 'x' } }), 'body', /"custom_instructions"/);
    h.assertRefused(assert, await api.call('POST', '/api/projects', { body: { name: 'A', knowledgeBaseIds: 'kb1' } }), 'body.knowledgeBaseIds', /list of knowledge base ids/);
    h.assertRefused(assert, await api.call('POST', '/api/projects', { body: { name: 'A', extractMemories: 'yes' } }), 'body.extractMemories');
    h.assertRefused(assert, await api.call('PUT', '/api/projects/p1/conversations', { body: { assign: ['c1'] } }), 'body.assign.0');
    h.assertRefused(assert, await api.call('DELETE', '/api/projects/conversations/c1?type=agnet'), 'query.type', /"direct" or "agent"/);
    assert.deepStrictEqual(db.queries, []);
});

test('a Blueprint request takes only its own keys', async () => {
    h.assertRefused(assert, await api.call('POST', '/api/projects/p1/package/export', { body: { save: true, notes: {} } }), 'body', /"notes"/);
    h.assertRefused(assert, await api.call('POST', '/api/projects/p1/package/upgrade', { body: { blueprintID: 'bp1' } }), 'body', /"blueprintID"/);
    h.assertRefused(assert, await api.call('POST', '/api/projects/package/install', { body: { manifest: [] } }), 'body.manifest', /JSON object/);
    assert.deepStrictEqual(db.queries, []);
});

test('the session is checked before the body', async () => {
    const res = await api.call('PUT', '/api/projects/p1/members/s1', { body: { role: 'edtor' }, user: null });
    assert.strictEqual(res.status, 401);
    assert.deepStrictEqual(db.queries, []);
});

test('a valid page request reaches the store and answers as before', async () => {
    const res = await api.call('GET', '/api/projects/p1/activity?limit=5&offset=0');
    assert.strictEqual(res.status, 200, res.text);
    assert.deepStrictEqual(res.body, { items: [], hasMore: false });
    assert.ok(db.queries.some((q) => /project_activity/.test(q)));
});
