'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

// The real store, its writer swapped for a recorder (verify.js reads it lazily).
let written = null;
require('../stores/configStore').setConfig = async (_k, v) => { written = v; };
const { _writeKnownKeys } = require('./verify');

test('known keys: an unparsable or missing timestamp is pruned, newest first', async () => {
    const recent = new Date(Date.now() - 1000).toISOString();
    const older = new Date(Date.now() - 5000).toISOString();
    await _writeKnownKeys({
        a: { pem: 'A', lastUsedAt: older },
        b: { pem: 'B', lastUsedAt: recent },
        junk: { pem: 'J', lastUsedAt: 'not-a-date' },
        none: { pem: 'N' },
    });
    assert.deepEqual(Object.keys(written), ['b', 'a']);
});
