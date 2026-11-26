// @typecheck
/**
 * The Teamwork helper's routes of /api/cowork (./coworkDeskRoutes.js): each reads its body through a strict schema
 * (text 1 to 1000 characters; a draft of 1 to 5 coworks and at most one role), sits behind a named per-user limit, and
 * hands the use case the caller and what was asked. A refusal of the use case (the budget, another organisation's
 * item) is answered with its status. The use cases are handed in (they have their own tests), so nothing is mocked.
 *
 * Run: cd server && node --test routes/coworkDeskRoutes.test.js
 */

'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert');
const express = require('express');

const { serve } = require('../testUtils/routeHarness');
const { mountDeskRoutes, HELPER_LIMIT_NAME, HELPER_CALLS_PER_MINUTE } = require('./coworkDeskRoutes');
const { HttpError } = require('../core/http/errors');

/** @type {Array<[string, Record<string, unknown>]>} */
let asked = [];
const helper = {
    draftDesk: async (/** @type {any} */ input) => {
        if (input.text === 'spent') throw new HttpError(409, 'cowork_budget_used', 'Your organisation has used its Cowork AI budget for this month.');
        if (input.itemId === 'cw-other-org') throw new HttpError(404, 'cowork_desk_helper_refused', 'That cowork does not exist.');
        asked.push(['draftDesk', input]);
        return { drafted: true, deskName: 'Desk', chain: [], roles: [], unmatched: [] };
    },
    applyDeskDraft: async (/** @type {any} */ input) => { asked.push(['applyDeskDraft', input]); return { deskId: 'd-1', done: [], waiting: [] }; },
};
/** @type {import('express').RequestHandler} */
const pass = (_req, _res, next) => next();

/** A router like routes/cowork.js mounts it: behind requireAuth. */
function routerWith(/** @type {Record<string, unknown>} */ overrides) {
    const router = express.Router();
    router.use((req, res, next) => (req.session?.user ? next() : res.status(401).json({ error: 'Authentication required' })));
    mountDeskRoutes(router, /** @type {any} */ ({ helper: () => helper, orgOf: async () => 'org-1', ...overrides }));
    return router;
}
const api = serve('/api/cowork', routerWith({ helperLimit: pass }), { user: { id: 'u1' } });
const limited = serve('/api/cowork', routerWith({}), { user: { id: 'u-limited' } });
after(() => { api.close(); limited.close(); });

const DRAFT = { deskName: 'Supplier invoices', chain: ['cw-1', 'cw-2'], roles: [{ role: 'Purchasing', holderId: 'ben', standInId: 'lena' }] };

test('the draft and the apply route hand the use case the caller and what was asked', async () => {
    asked = [];
    assert.strictEqual((await api.call('POST', '/api/cowork/desks/helper/draft', { body: { text: '  Ben checks the invoices ', itemId: 'cw-1' } })).status, 200);
    assert.strictEqual((await api.call('POST', '/api/cowork/desks/helper/draft', { body: { text: 'Ben checks' } })).status, 200);
    assert.strictEqual((await api.call('POST', '/api/cowork/desks/helper/apply', { body: { draft: DRAFT, expectedDeskId: 'd-1' } })).status, 201);
    assert.deepStrictEqual(asked, [
        ['draftDesk', { userId: 'u1', text: 'Ben checks the invoices', itemId: 'cw-1', userOrgId: 'org-1' }],
        ['draftDesk', { userId: 'u1', text: 'Ben checks', itemId: null, userOrgId: 'org-1' }],
        ['applyDeskDraft', { userId: 'u1', itemId: null, expectedDeskId: 'd-1', draft: DRAFT }],
    ]);
});

test('validation: text 1 to 1000 characters, no other fields; a draft of 1 to 5 coworks and at most one role', async () => {
    asked = [];
    const bad = [
        ['draft', {}], ['draft', { text: '   ' }], ['draft', { text: 'x'.repeat(1001) }], ['draft', { text: 'ok', extra: 1 }], ['draft', { text: 'ok', itemId: '' }],
        ['apply', {}], ['apply', { draft: { ...DRAFT, chain: [] } }], ['apply', { draft: { ...DRAFT, chain: ['a', 'b', 'c', 'd', 'e', 'f'] } }],
        ['apply', { draft: { ...DRAFT, roles: [DRAFT.roles[0], { role: 'Two', holderId: 'x' }] } }], ['apply', { draft: { ...DRAFT, deskName: '' } }],
        ['apply', { draft: { ...DRAFT, sneaky: true } }],
    ];
    for (const [route, body] of bad) assert.strictEqual((await api.call('POST', `/api/cowork/desks/helper/${route}`, { body })).status, 400, JSON.stringify(body));
    assert.strictEqual((await api.call('POST', '/api/cowork/desks/helper/draft', { body: { text: 'x'.repeat(1000) } })).status, 200);
    assert.strictEqual(asked.length, 1, 'only the valid body reached the use case');
});

test('refusals are answered with their status: no session 401, the budget 409, another organisation\'s item 404', async () => {
    assert.strictEqual((await api.call('POST', '/api/cowork/desks/helper/draft', { body: { text: 'hi' }, user: null })).status, 401);
    assert.strictEqual((await api.call('POST', '/api/cowork/desks/helper/apply', { body: { draft: DRAFT }, user: null })).status, 401);
    const spent = await api.call('POST', '/api/cowork/desks/helper/draft', { body: { text: 'spent' } });
    assert.deepStrictEqual([spent.status, spent.body.code], [409, 'cowork_budget_used']);
    assert.strictEqual((await api.call('POST', '/api/cowork/desks/helper/draft', { body: { text: 'hi', itemId: 'cw-other-org' } })).status, 404);
});

test('a named per-user limit: after its budget the caller gets 429', async () => {
    assert.strictEqual(HELPER_LIMIT_NAME, 'cowork-desk-helper');
    const statuses = [];
    for (let i = 0; i <= HELPER_CALLS_PER_MINUTE; i += 1) statuses.push((await limited.call('POST', '/api/cowork/desks/helper/draft', { body: { text: 'hi' } })).status);
    assert.deepStrictEqual(statuses, [...Array(HELPER_CALLS_PER_MINUTE).fill(200), 429]);
});
