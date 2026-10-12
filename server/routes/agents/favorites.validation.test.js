/**
 * What the agent favourites bulk route accepts, and what it says when it
 * refuses (routes/agents/favorites.js).
 *
 * "agentIds array required" named no field and no reason, and it was also the
 * answer to a misspelled key — so the one-time migration of a browser's
 * favourites failed with nothing to act on. What this file pins is the part a
 * caller can act on:
 *
 *   - the 400 NAMES the field (`body.agentIds`), not just "invalid request";
 *   - the store is never reached, so a refused request changes nothing;
 *   - a blank entry is still DROPPED rather than refused: this is a migration
 *     of whatever a browser had, and the other favourites must still arrive;
 *   - too MANY ids is still a 413, which a schema refusal cannot answer.
 *
 * Run: cd server && node --test --test-force-exit routes/agents/favorites.validation.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

// Every store call lands in `touched`. A refused request must leave it empty.
const touched = [];

const MOCKS = {
    '../../stores/agentStore': {
        listAgentFavorites: async () => ['a1'],
        addAgentFavorite: async (...a) => { touched.push({ what: 'addAgentFavorite', args: a }); return true; },
        removeAgentFavorite: async (...a) => { touched.push({ what: 'removeAgentFavorite', args: a }); return true; },
        getAgent: async (id) => ({ id, owner_id: 'u1' }),
    },
    './crud': { canReadAgent: async () => true },
};

const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:agent-favorites-validation:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /agents[\\/]favorites\.js$/.test(parent.filename)
        && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const router = require('./favorites');
test.after(() => { Module._resolveFilename = originalResolve; });

const { dispatcher } = require('../../core/http/routeHarness');

const dispatch = dispatcher(router);

test.beforeEach(() => { touched.length = 0; });

test('a list that is not a list is refused by name, and nothing is favourited', async () => {
    const res = await dispatch({ method: 'POST', url: '/favorites/bulk', body: { agentIds: 'a1' } });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'agentIds is a list of agent ids.');
    assert.ok(res.body.details.some((d) => d.path === 'body.agentIds'));
    assert.deepStrictEqual(touched, []);
});

test('a misspelled key is refused by name rather than read as "no list at all"', async () => {
    const res = await dispatch({ method: 'POST', url: '/favorites/bulk', body: { agentIDs: ['a1'] } });
    assert.strictEqual(res.statusCode, 400);
    assert.deepStrictEqual(touched, []);
});

test('an entry that is not text is named by its index', async () => {
    const res = await dispatch({ method: 'POST', url: '/favorites/bulk', body: { agentIds: ['a1', 7] } });
    assert.strictEqual(res.statusCode, 400);
    assert.ok(res.body.details.some((d) => d.path === 'body.agentIds.1'));
    assert.deepStrictEqual(touched, []);
});

test('a blank entry is dropped, and the rest of the migration still lands', async () => {
    const res = await dispatch({ method: 'POST', url: '/favorites/bulk', body: { agentIds: ['a1', '', 'a2'] } });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(touched.map((t) => t.args[1]), ['a1', 'a2']);
});

test('too many ids is still a 413 — a size, not a shape', async () => {
    const res = await dispatch({ method: 'POST', url: '/favorites/bulk', body: { agentIds: Array.from({ length: 201 }, (_, i) => `a${i}`) } });
    assert.strictEqual(res.statusCode, 413);
    assert.deepStrictEqual(touched, []);
});
