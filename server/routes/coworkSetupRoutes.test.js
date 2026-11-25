// @typecheck
/**
 * The set-up route of /api/cowork (./coworkSetupRoutes.js): the task is the caller's before anything else, the body is
 * one of two modes, and the answer is the set-up as it now stands. The item loader and the use case are handed in
 * (the use case has its own tests, usecases/coworkSetup.test.js), so nothing is mocked. And the trail records the
 * choice as the plan coming off or being named again, without anything the owner wrote.
 *
 * Run: cd server && node --test routes/coworkSetupRoutes.test.js
 */

'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert');
const express = require('express');

const { serve } = require('../testUtils/routeHarness');
const { mountSetupRoutes } = require('./coworkSetupRoutes');
const { mountAuditRoutes } = require('./coworkAuditRoutes');
const { HttpError } = require('../core/http/errors');

const URL = '/api/cowork/cw-1/setup';
/** @type {Array<[string, unknown]>} */
let asked = [];
const loadItem = async (/** @type {string} */ id, /** @type {string} */ userId) => {
    if (id !== 'cw-1') throw new HttpError(404, 'cowork_refused', 'Not found');
    if (userId !== 'u1') throw new HttpError(403, 'cowork_refused', 'Forbidden');
    return /** @type {any} */ ({ id, userId, planAutomationId: 'auto-1', planId: null });
};
const setup = {
    chooseMode: async (/** @type {any} */ { item, mode }) => {
        asked.push(['chooseMode', [item.id, mode]]);
        if (mode === 'steps') throw new HttpError(409, 'cowork_setup_refused', 'There is nothing to undo: this task was not switched to the AI from its steps.');
        return /** @type {any} */ ({ steps: 'ai', cause: null, since: null, sendsTo: null, askFirst: null, canUndo: true });
    },
};

const router = express.Router();
router.use((req, res, next) => (req.session?.user ? next() : res.status(401).json({ error: 'Authentication required' })));
mountAuditRoutes(router, { loadItem, record: async (action, id, _by, fields) => { asked.push(['record', [action, id, fields]]); }, trail: async () => /** @type {any} */ ([]) });
mountSetupRoutes(router, { loadItem, setup: () => setup });
const api = serve('/api/cowork', router, { user: { id: 'u1' } });
after(api.close);

const settle = () => new Promise((resolve) => setImmediate(resolve));

test('letting the AI work it out answers the set-up as it now stands, and the trail says the plan came off', async () => {
    asked = [];
    const res = await api.call('PUT', URL, { body: { mode: 'ai' } });
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.body, { setup: { steps: 'ai', cause: null, since: null, sendsTo: null, askFirst: null, canUndo: true } });
    await settle();
    assert.deepStrictEqual(asked, [['chooseMode', ['cw-1', 'ai']], ['record', ['cowork.plan_removed', 'cw-1', { mode: 'ai' }]]]);
});

test('a refused Undo is an ordinary answer with its reason, and leaves no trail', async () => {
    asked = [];
    const res = await api.call('PUT', URL, { body: { mode: 'steps' } });
    assert.deepStrictEqual([res.status, res.body.code], [409, 'cowork_setup_refused']);
    await settle();
    assert.deepStrictEqual(asked, [['chooseMode', ['cw-1', 'steps']]]);
});

test('it is its owner\'s to choose: no session is 401, another person 403, an unknown task 404, and the body is one of two modes', async () => {
    asked = [];
    assert.strictEqual((await api.call('PUT', URL, { user: null, body: { mode: 'ai' } })).status, 401);
    assert.strictEqual((await api.call('PUT', URL, { user: { id: 'someone-else' }, body: { mode: 'ai' } })).status, 403);
    assert.strictEqual((await api.call('PUT', URL.replace('cw-1', 'cw-9'), { body: { mode: 'ai' } })).status, 404);
    for (const body of [{}, { mode: 'agent' }, { mode: 'ai', sendsTo: ['sam@example.com'] }]) {
        assert.strictEqual((await api.call('PUT', URL, { body })).status, 400, JSON.stringify(body));
    }
    assert.deepStrictEqual(asked, []);
});
