// @typecheck strict
'use strict';

const { entriesInKeyOrder } = require('../../entryKeyOrder');

module.exports = {
    since: 3,
    kinds: ['aggregate'],
    shape: '[{ field: <an aggregate\'s as>, op: eq|neq|gt|gte|lt|lte, value: <number> }] of 1 to 5 entries',
    description: 'Keeps only the groups whose aggregate passes (SQL HAVING). The clauses AND each other.',
    // Kept as authored, each clause's keys in a fixed order: validate/aggregateChecks.mts judges the list.
    clean: entriesInKeyOrder(['field', 'op', 'value']),
};
