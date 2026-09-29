/**
 * origin — BEEFLOW_SERVER_LOCATION parsing.
 *
 * Run: node --test server/core/http/geo/origin.test.js
 */

const assert = require('node:assert');
const { test } = require('node:test');
const { serverOrigin } = require('./origin');

test('unset or empty → null (no NL default)', () => {
    assert.strictEqual(serverOrigin(''), null);
    assert.strictEqual(serverOrigin(undefined), null);
    assert.strictEqual(serverOrigin('   '), null);
});

test('an ISO code → the capital as reference point, the country as label', () => {
    assert.deepStrictEqual(serverOrigin('nl'), { country_code: 'NL', country_name: 'Netherlands', lat: 52.37, lon: 4.9, label: 'Netherlands' });
    assert.strictEqual(serverOrigin('DE').lat, 52.52);
    assert.strictEqual(serverOrigin('ZZ'), null, 'unknown code');
    assert.strictEqual(serverOrigin('BT'), null, 'a real country without a reference point asks for coordinates');
});

test('"lat,lon[,label]"', () => {
    assert.deepStrictEqual(serverOrigin('52.39, 4.64'), { country_code: null, country_name: null, lat: 52.39, lon: 4.64, label: null });
    assert.strictEqual(serverOrigin('50.11,8.68,Frankfurt, rack 4').label, 'Frankfurt, rack 4');
    for (const bad of ['52.39', '91,4', '52,181', 'abc,def', ',4', 'Amsterdam']) {
        assert.strictEqual(serverOrigin(bad), null, bad);
    }
});
