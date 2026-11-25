// @typecheck
/**
 * The proposal routes of /api/cowork (./coworkProposalRoutes.js): the item is the caller's before anything else, the
 * bodies are exactly what each route reads, and the use cases get the item and what was asked. The item loader and
 * the use cases are handed in (they have their own tests), so nothing is mocked.
 *
 * Run: cd server && node --test routes/coworkProposalRoutes.test.js
 */

'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert');
const express = require('express');

const { serve } = require('../testUtils/routeHarness');
const { mountProposalRoutes } = require('./coworkProposalRoutes');
const { HttpError } = require('../core/http/errors');

const LIST = { proposals: [{ id: 'pr-1', kind: 'repair', status: 'open' }] };
const FP = 'f'.repeat(64);

/** @type {Array<[string, Record<string, unknown>]>} */
let asked = [];
const proposals = {
    proposalsOf: async (item) => { asked.push(['proposalsOf', { item: item.id }]); return LIST; },
    approveProposal: async ({ item, proposalId, fingerprint }) => { asked.push(['approveProposal', { item: item.id, proposalId, fingerprint }]); return LIST; },
    dismissProposal: async ({ item, proposalId }) => { asked.push(['dismissProposal', { item: item.id, proposalId }]); return LIST; },
};
const versions = { restoreVersion: async ({ item, version }) => { asked.push(['restoreVersion', { item: item.id, version }]); return { approved: { version: 4 } }; } };
const loadItem = async (/** @type {string} */ id, /** @type {string} */ userId) => {
    if (id !== 'cw-1') throw new HttpError(404, 'cowork_refused', 'Not found');
    if (userId !== 'u1') throw new HttpError(403, 'cowork_refused', 'Forbidden');
    return /** @type {any} */ ({ id, userId });
};

const router = express.Router();
router.use((req, res, next) => (req.session?.user ? next() : res.status(401).json({ error: 'Authentication required' })));
mountProposalRoutes(router, { loadItem, proposals: () => /** @type {any} */ (proposals), versions: () => /** @type {any} */ (versions) });
const api = serve('/api/cowork', router, { user: { id: 'u1' } });
after(api.close);

test('list, approve with the fingerprint looked at, dismiss, and restore a version', async () => {
    asked = [];
    assert.deepStrictEqual(await api.call('GET', '/api/cowork/cw-1/proposals').then((r) => [r.status, r.body]), [200, LIST]);
    assert.strictEqual((await api.call('POST', '/api/cowork/cw-1/proposals/pr-1/approve', { body: { fingerprint: FP } })).status, 200);
    assert.strictEqual((await api.call('POST', '/api/cowork/cw-1/proposals/pr-1/dismiss')).status, 200);
    assert.strictEqual((await api.call('POST', '/api/cowork/cw-1/plan/restore', { body: { version: 3 } })).status, 200);
    assert.deepStrictEqual(asked, [
        ['proposalsOf', { item: 'cw-1' }],
        ['approveProposal', { item: 'cw-1', proposalId: 'pr-1', fingerprint: FP }],
        ['dismissProposal', { item: 'cw-1', proposalId: 'pr-1' }],
        ['restoreVersion', { item: 'cw-1', version: 3 }],
    ]);
});

test('a proposal is its owner\'s: no session 401, another person 403, an unknown item 404, and no use case is reached', async () => {
    asked = [];
    /** @type {Array<{ method: string, url: string, body?: Record<string, unknown> }>} */
    const calls = [{ method: 'GET', url: '/api/cowork/cw-1/proposals' }, { method: 'POST', url: '/api/cowork/cw-1/proposals/pr-1/approve', body: { fingerprint: FP } },
        { method: 'POST', url: '/api/cowork/cw-1/proposals/pr-1/dismiss' }, { method: 'POST', url: '/api/cowork/cw-1/plan/restore', body: { version: 1 } }];
    for (const { method, url, body } of calls) {
        assert.strictEqual((await api.call(method, url, { user: null, body })).status, 401);
        assert.strictEqual((await api.call(method, url, { user: { id: 'someone-else' }, body })).status, 403);
        assert.strictEqual((await api.call(method, url.replace('cw-1', 'cw-9'), { body })).status, 404);
    }
    assert.deepStrictEqual(asked, []);
});

test('the bodies are exactly what the routes read', async () => {
    asked = [];
    for (const body of [{}, { fingerprint: 'short' }, { fingerprint: FP, also: 1 }]) {
        assert.strictEqual((await api.call('POST', '/api/cowork/cw-1/proposals/pr-1/approve', { body })).status, 400, JSON.stringify(body));
    }
    assert.strictEqual((await api.call('POST', '/api/cowork/cw-1/proposals/pr-1/dismiss', { body: { why: 'no' } })).status, 400);
    for (const body of [{}, { version: 0 }, { version: 1.5 }, { version: 'last' }]) {
        assert.strictEqual((await api.call('POST', '/api/cowork/cw-1/plan/restore', { body })).status, 400, JSON.stringify(body));
    }
    assert.deepStrictEqual(asked, []);
});
