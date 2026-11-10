'use strict';

/**
 * The value-formatting limits live in LIMITS (the definition-validity constants) and in the
 * shared cleaner the browser runs too (server/shared/format/formatClean.mjs). They are one
 * number each.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { LIMITS } = require('./limits');
const { FORMAT_LIMITS } = require('../../shared/format/formatClean.mjs');

test('LIMITS.MAX_FORMAT_* and the shared cleaner agree', () => {
    assert.deepEqual(
        {
            MAX_DECIMALS: LIMITS.MAX_FORMAT_DECIMALS,
            MAX_PATTERN_LEN: LIMITS.MAX_FORMAT_PATTERN_LEN,
            MAX_LANGUAGE_LEN: LIMITS.MAX_FORMAT_LANGUAGE_LEN,
            MAX_TIME_ZONE_LEN: LIMITS.MAX_FORMAT_TIME_ZONE_LEN,
        },
        { ...FORMAT_LIMITS },
    );
});
