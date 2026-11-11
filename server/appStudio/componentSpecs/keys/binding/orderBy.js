// @typecheck strict
'use strict';

const { entriesInKeyOrder } = require('../../entryKeyOrder');

module.exports = {
    since: 3,
    kinds: ['record', 'records', 'aggregate'],
    shape: '[{ field, dir?: "asc"|"desc" }] of 1 to 3 entries',
    description: 'Sorts on several columns, in the order listed. Use it instead of sort, not beside it. On an aggregate binding a field is one of its output columns (a groupBy column or an aggregate\'s as).',
    // Kept as authored, each entry's keys in a fixed order: validate/bindings.js judges the list.
    clean: entriesInKeyOrder(['field', 'dir']),
};
