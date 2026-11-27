'use strict';
/**
 * The Adoption report's drill-down of the automation module's kind, through the
 * real router chain (./usageAdoption.authz.testkit.js): nothing of organisation
 * B reaches a caller of A.
 *
 * Run: cd server && node --test routes/usageAdoption.authz.automation.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const r = require('./usageAdoption.authz.testkit');

r.useAdoptionApi();

test('nothing of organisation B reaches organisation A', async () => {
    for (const url of ['/studio/items?kind=automation']) {
        const res = await r.get(url, r.as('a-owner'));
        assert.equal(res.status, 200, `${url}: ${res.text}`);
        assert.ok(!r.B_TRACE.test(res.text), `${url} leaks org B: ${res.text.slice(0, 300)}`);
    }
});
