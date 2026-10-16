/**
 * The revision a client names on a CMS save (stores/cms/revision.js).
 *
 * Run: node --test stores/cms/revision.test.js
 */
const test = require('node:test');
const assert = require('node:assert');
const { mock } = require('node:test');

const log = require('../../telemetry/log');
const { clientRev, assertRevMatches, revOf } = require('./revision');

test('a revision the client names is passed on unchanged', () => {
    const warn = mock.method(log, 'warn', () => {});
    assert.strictEqual(clientRev(0, 'page', { route: 'PUT /pages/:id', siteId: 'pj_x' }), 0);
    assert.strictEqual(clientRev(7, 'page', { route: 'PUT /pages/:id', siteId: 'pj_x' }), 7);
    assert.strictEqual(warn.mock.callCount(), 0);
    warn.mock.restore();
});

test('soft path: a missing or malformed revision is unchecked, and logged with the route and site id only', () => {
    const warn = mock.method(log, 'warn', () => {});
    for (const raw of [undefined, null, '3', 1.5, -1]) {
        assert.strictEqual(clientRev(raw, 'site', { route: 'PUT /site', siteId: 'pj_x' }), undefined);
    }
    assert.strictEqual(warn.mock.callCount(), 5);
    assert.match(String(warn.mock.calls[0].arguments[0]), /PUT \/site site=pj_x/);
    warn.mock.restore();
});

test('assertRevMatches: unchecked without an expected revision, 404 for a missing document, 409 for another revision', () => {
    assert.doesNotThrow(() => assertRevMatches(null, undefined, 'page'));
    assert.doesNotThrow(() => assertRevMatches({ rev: 2 }, 2, 'page'));
    assert.throws(() => assertRevMatches(null, 0, 'page'), (e) => e.status === 404);
    assert.throws(() => assertRevMatches({ rev: 3 }, 2, 'page'), (e) => e.status === 409);
    assert.strictEqual(revOf({}), 0);
});
