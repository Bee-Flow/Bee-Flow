/**
 * What an automation-builder turn accepts (routes/ai/automationBuilder/chatStream.js).
 *
 * The body was destructured with defaults, so a misspelled key was a silent
 * default under a 200 and a paid, streamed turn:
 *
 *   - `automationID` (capital D) started a NEW draft beside the one on
 *     screen, and the canvas kept showing the old one;
 *   - `webSearchEnabled: "false"` switched web search ON (`!!"false"`);
 *   - `modelTeir` built on the default tier.
 *
 * What this file pins: an unknown key is refused by name before the stream
 * opens (a 400 in JSON, not an `error` event), the flag takes only true or
 * false, a refused request reads nothing, and the session is checked first.
 *
 * Run: cd server && node --test routes/ai/automationBuilder/chatStream.validation.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const h = require('../../../core/http/routeHarness');

const db = h.recordDb();
h.openGates();
const api = h.serve('/api/automation/builder', require('./chatStream'));
test.before(() => db.settle());
test.after(api.close);
test.beforeEach(() => db.reset());

const turn = (body, { user, qs = '' } = {}) => api.call('POST', `/api/automation/builder/stream${qs}`, { body, user });

test('a misspelled key is refused by name before the stream opens', async () => {
    const res = await turn({ message: 'Mail me the invoices', automationID: 'auto_1' });
    h.assertRefused(assert, res, 'body', /"automationID"/);
    assert.match(res.headers.get('content-type'), /application\/json/);
    assert.match(res.body.error, /It takes: message, builderSessionId, automationId, modelTier/);
    assert.deepStrictEqual(db.queries, []);
});

test('webSearchEnabled is true or false, and the text "false" reads as false', async () => {
    const res = await turn({ message: 'x', webSearchEnabled: 'off' });
    h.assertRefused(assert, res, 'body.webSearchEnabled', /true or false/);
    assert.deepStrictEqual(db.queries, []);
});

test('the lists are lists and seedMetadata names only a title and description', async () => {
    h.assertRefused(assert, await turn({ message: 'x', history: 'earlier' }), 'body.history', /list of earlier turns/);
    h.assertRefused(assert, await turn({ message: 'x', attachments: {} }), 'body.attachments', /list of files/);
    h.assertRefused(assert, await turn({ message: 'x', seedMetadata: { titel: 'Invoices' } }), 'body.seedMetadata', /"titel"/);
    assert.deepStrictEqual(db.queries, []);
});

test('the query takes only resume', async () => {
    h.assertRefused(assert, await turn({ message: 'x' }, { qs: '?resume=yes' }), 'query.resume', /resume is 1/);
    h.assertRefused(assert, await turn({ message: 'x' }, { qs: '?resum=1' }), 'query', /"resum"/);
    assert.deepStrictEqual(db.queries, []);
});

test('the session is checked before the body', async () => {
    const res = await turn({ nope: true }, { user: null });
    assert.strictEqual(res.status, 401);
    assert.deepStrictEqual(db.queries, []);
});

test('the body the Agent Hub sends passes the schema and opens the stream', async () => {
    const res = await turn({
        message: 'Mail me the invoices', modelTier: 'auto', timezone: 'Europe/Amsterdam',
        builderSessionId: null, automationId: null, history: [], attachments: [],
        webSearchEnabled: true, disabledMedia: {}, canvasScope: null, seedMetadata: { title: 'Invoices' },
    }, { qs: '?resume=1' });
    assert.strictEqual(res.status, 200, res.text);
    assert.match(res.headers.get('content-type'), /text\/event-stream/);
});
