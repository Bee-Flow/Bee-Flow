// @typecheck
/**
 * The trail of /api/cowork (./coworkAuditRoutes.js): every change that succeeded is written once, with the action
 * read from its method and path; a refused one is not; the owner reads the trail. Writing and reading are handed in,
 * so nothing is mocked.
 *
 * Run: cd server && node --test routes/coworkAuditRoutes.test.js
 */

'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert');
const express = require('express');

const { serve } = require('../testUtils/routeHarness');
const { mountAuditRoutes, actionOf } = require('./coworkAuditRoutes');
const { HttpError } = require('../core/http/errors');

/** @type {Array<[string, string, unknown, unknown]>} */
let written = [];
const loadItem = async (id, userId) => {
    if (id !== 'cw-1') throw new HttpError(404, 'cowork_refused', 'Not found');
    if (userId !== 'u1') throw new HttpError(403, 'cowork_refused', 'Forbidden');
    return /** @type {any} */ ({ id, userId });
};

const router = express.Router();
router.use(express.json());
mountAuditRoutes(router, {
    loadItem,
    record: async (action, id, by, fields) => { written.push([action, id, by, fields]); },
    trail: async (id, viewer) => [/** @type {any} */ ({ action: 'cowork.created', at: null, byYou: viewer === 'u1', changed: [], values: {} })],
});
// Stand-ins for the routes the trail watches: they answer what the real ones would.
router.post('/', (req, res) => { res.status(201).json({ id: 'cw-new' }); });
router.put('/:id', (req, res) => { res.json({ success: true }); });
router.delete('/:id', (req, res) => { res.json({ success: true }); });
router.post('/:id/toggle', (req, res) => { res.json({ isActive: false }); });
router.post('/:id/plan/approve', (req, res) => { res.status(409).json({ error: 'changed' }); });
router.post('/:id/runs/:runId/review', (req, res) => { res.json({ ok: true }); });
router.get('/:id/runs', (req, res) => { res.json({ runs: [] }); });
const api = serve('/api/cowork', router, { user: { id: 'u1', organizationId: 'org-1' } });
after(api.close);

const settled = () => new Promise((resolve) => { setImmediate(resolve); });

test('each change that succeeded is written once, with its action, its item, who made it and what it carried', async () => {
    written = [];
    await api.call('POST', '/api/cowork', { body: { title: 'T', prompt: 'P' } });
    await api.call('PUT', '/api/cowork/cw-1', { body: { isActive: false, prompt: 'new text' } });
    await api.call('POST', '/api/cowork/cw-1/toggle', { body: {} });
    await api.call('POST', '/api/cowork/cw-1/runs/r-1/review', { body: { action: 'not_needed' } });
    await api.call('DELETE', '/api/cowork/cw-1');
    await settled();
    assert.deepStrictEqual(written.map(([action, id]) => [action, id]), [
        ['cowork.created', 'cw-new'], ['cowork.updated', 'cw-1'], ['cowork.toggled', 'cw-1'], ['cowork.review_handled', 'cw-1'], ['cowork.deleted', 'cw-1'],
    ]);
    assert.deepStrictEqual(written[1][2], { userId: 'u1', organizationId: 'org-1' });
    assert.deepStrictEqual(written[1][3], { isActive: false, prompt: 'new text' }, 'the use case keeps only its allow-list of it');
});

test('a refused change and a read are not written', async () => {
    written = [];
    await api.call('POST', '/api/cowork/cw-1/plan/approve', { body: { fingerprint: 'a'.repeat(64) } });
    await api.call('GET', '/api/cowork/cw-1/runs');
    await settled();
    assert.deepStrictEqual(written, []);
});

test('the trail is its owner\'s to read', async () => {
    const own = await api.call('GET', '/api/cowork/cw-1/audit');
    assert.deepStrictEqual([own.status, own.body.entries[0].byYou], [200, true]);
    assert.strictEqual((await api.call('GET', '/api/cowork/cw-1/audit', { user: { id: 'someone-else' } })).status, 403);
    assert.strictEqual((await api.call('GET', '/api/cowork/cw-9/audit')).status, 404);
});

test('the action is read from the method and the path; anything else is no change', () => {
    const cases = /** @type {Array<[string, string, unknown]>} */ ([
        ['POST', '/', { action: 'cowork.created', id: null }],
        ['PUT', '/cw-1', { action: 'cowork.updated', id: 'cw-1' }],
        ['PUT', '/cw-1/plan', { action: 'cowork.plan_attached', id: 'cw-1' }],
        ['DELETE', '/cw-1/plan', { action: 'cowork.plan_removed', id: 'cw-1' }],
        ['POST', '/cw-1/plan/make', null],
        ['POST', '/cw-1/run-now', null],
        ['POST', '/cw-1/plan/try', null],
        ['POST', '/compose', null],
        ['GET', '/cw-1', null],
    ]);
    for (const [method, path, expected] of cases) assert.deepStrictEqual(actionOf(method, path), expected, `${method} ${path}`);
});
