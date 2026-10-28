'use strict';

// express-rate-limit checks a custom keyGenerator when the limiter is built
// (module load) and logs ERR_ERL_KEY_GEN_IPV6 when it reads req.ip without
// ipKeyGenerator: an IPv6 client could then rotate through its /64 for fresh
// buckets (#280).

const { test } = require('node:test');
const assert = require('node:assert');

test('the resource limiter builds without the IPv6 key warning', () => {
    const seen = [];
    const original = console.error;
    console.error = (...args) => { seen.push(args.map(String).join(' ')); };
    try {
        require('./ncScope');
    } finally {
        console.error = original;
    }
    assert.deepStrictEqual(seen.filter((l) => l.includes('ERR_ERL_KEY_GEN_IPV6') || l.includes('ipKeyGenerator')), []);
});
