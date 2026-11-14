/**
 * What the webhook secret routes of an app trigger accept (routes/studioApps/triggers.js):
 * revealing or rotating a secret takes no fields. The owner gate runs first, so a
 * stranger reads the uniform 404 whatever the body holds.
 *
 * Run: cd server && node --test routes/studioApps/triggers.validation.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const h = require('../../testUtils/routeHarness');

const APP = { id: 'app1', user_id: 'u1', name: 'A', definition: '{}' };
const { api } = h.routeUnderTest(test, '/api/studio-apps', () => require('./triggers'), {
    answer: (sql) => (/FROM studio_apps WHERE id/.test(sql) ? { rows: [APP] } : undefined),
});

test('revealing or rotating a webhook secret takes no fields: one sent is refused by name', async () => {
    for (const action of ['secret', 'rotate']) {
        const res = await api.call('POST', `/api/studio-apps/app1/triggers/trg_1/webhook/${action}`, { body: { secret: 'mine' } });
        h.assertRefused(assert, res, 'body', /does not take "secret"/);
    }
});

test('the owner gate answers before the body is read', async () => {
    const stranger = { ...h.USER, id: 'u2' };
    const res = await api.call('POST', '/api/studio-apps/app1/triggers/trg_1/webhook/rotate', { body: { secret: 'mine' }, user: stranger });
    assert.strictEqual(res.status, 404, res.text);
});
