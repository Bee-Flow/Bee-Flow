// @typecheck
/**
 * The memory routes of /api/cowork (./coworkMemoryRoutes.js) and their use case (../usecases/coworkMemory.mts): the
 * item is the caller's before anything else, the bodies are exactly what each route reads, a clear hands back what it
 * cleared and Undo restores exactly that. The item loader and the store are handed in, so nothing is mocked.
 *
 * Run: cd server && node --test routes/coworkMemoryRoutes.test.js
 */

'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert');
const express = require('express');

const { serve } = require('../testUtils/routeHarness');
const { mountMemoryRoutes } = require('./coworkMemoryRoutes');
const { memoriesOf, clearMemories, restoreMemories } = require('../usecases/coworkMemory.mts');
const { HttpError } = require('../core/http/errors');

/** @type {Map<string, { id: string, value: string | null, summary: string | null, subject: string, status: string }>} */
const rows = new Map();
const reset = () => {
    rows.clear();
    rows.set('m1', { id: 'm1', value: 'Invoice 2026-114 from Orbis', summary: null, subject: 'inv-114', status: 'active' });
    rows.set('m2', { id: 'm2', value: null, summary: 'Contract renewal with Northwind', subject: 'ctr-9', status: 'active' });
};
/** @type {Array<[string, unknown]>} */
let asked = [];
const store = {
    getScheduleCoverage: async (/** @type {string} */ scheduleId) => { asked.push(['get', scheduleId]); return [...rows.values()].filter((r) => r.status === 'active'); },
    clearScheduleCoverage: async (/** @type {string} */ userId, /** @type {string} */ scheduleId) => {
        asked.push(['clear', [userId, scheduleId]]);
        const ids = [...rows.values()].filter((r) => r.status === 'active').map((r) => r.id);
        for (const id of ids) rows.get(id).status = 'superseded';
        return ids;
    },
    restoreScheduleCoverage: async (/** @type {string} */ userId, /** @type {string} */ scheduleId, /** @type {string[]} */ ids) => {
        asked.push(['restore', [userId, scheduleId, ids]]);
        let n = 0;
        for (const id of ids) { const r = rows.get(id); if (r && r.status === 'superseded') { r.status = 'active'; n += 1; } }
        return n;
    },
};
const loadItem = async (/** @type {string} */ id, /** @type {string} */ userId) => {
    if (id !== 'cw-1') throw new HttpError(404, 'cowork_refused', 'Not found');
    if (userId !== 'u1') throw new HttpError(403, 'cowork_refused', 'Forbidden');
    return /** @type {any} */ ({ id, userId });
};
const memory = {
    memoriesOf: (/** @type {any} */ item) => memoriesOf(item, store),
    clearMemories: (/** @type {any} */ item) => clearMemories(item, store),
    restoreMemories: (/** @type {any} */ item, /** @type {string[]} */ ids) => restoreMemories(item, ids, store),
};

const router = express.Router();
router.use((req, res, next) => (req.session?.user ? next() : res.status(401).json({ error: 'Authentication required' })));
mountMemoryRoutes(router, { loadItem, memory: () => /** @type {any} */ (memory) });
const api = serve('/api/cowork', router, { user: { id: 'u1' } });
after(api.close);

test('the owner reads what the task remembers, clears it, and Undo brings exactly that back', async () => {
    reset();
    const read = await api.call('GET', '/api/cowork/cw-1/memory');
    assert.deepStrictEqual(read.body.memories.map((/** @type {any} */ m) => [m.id, m.text]), [['m1', 'Invoice 2026-114 from Orbis'], ['m2', 'Contract renewal with Northwind']]);
    const cleared = await api.call('POST', '/api/cowork/cw-1/memory/clear');
    assert.deepStrictEqual([cleared.status, cleared.body], [200, { cleared: ['m1', 'm2'] }]);
    assert.deepStrictEqual((await api.call('GET', '/api/cowork/cw-1/memory')).body, { memories: [] });
    const undone = await api.call('POST', '/api/cowork/cw-1/memory/restore', { body: { ids: ['m1', 'm2'] } });
    assert.deepStrictEqual([undone.status, undone.body], [200, { restored: 2 }]);
    assert.strictEqual((await api.call('GET', '/api/cowork/cw-1/memory')).body.memories.length, 2);
    assert.deepStrictEqual(asked.filter(([what]) => what !== 'get').map(([what, args]) => [what, args]), [['clear', ['u1', 'cw-1']], ['restore', ['u1', 'cw-1', ['m1', 'm2']]]]);
});

test('a task\'s memory is its owner\'s: no session 401, another person 403, an unknown task 404, and the store is never reached', async () => {
    reset();
    asked = [];
    const calls = [{ method: 'GET', url: '/api/cowork/cw-1/memory' }, { method: 'POST', url: '/api/cowork/cw-1/memory/clear' }, { method: 'POST', url: '/api/cowork/cw-1/memory/restore', body: { ids: ['m1'] } }];
    for (const { method, url, body } of calls) {
        assert.strictEqual((await api.call(method, url, { user: null, body })).status, 401);
        assert.strictEqual((await api.call(method, url, { user: { id: 'someone-else' }, body })).status, 403);
        assert.strictEqual((await api.call(method, url.replace('cw-1', 'cw-9'), { body })).status, 404);
    }
    assert.deepStrictEqual(asked, []);
});

test('the bodies are exactly what the routes read', async () => {
    asked = [];
    assert.strictEqual((await api.call('POST', '/api/cowork/cw-1/memory/clear', { body: { all: true } })).status, 400);
    for (const body of [{}, { ids: 'm1' }, { ids: [''] }, { ids: ['m1'], also: 1 }]) {
        assert.strictEqual((await api.call('POST', '/api/cowork/cw-1/memory/restore', { body })).status, 400, JSON.stringify(body));
    }
    assert.deepStrictEqual(asked, []);
});
