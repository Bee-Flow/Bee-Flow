// @typecheck strict
'use strict';

module.exports = {
    since: 3,
    kinds: ['record', 'records'],
    shape: '[<field key>] of 1 to 100 entries',
    description: 'Returns only these columns of each record (and id). Leave it out to read every column.',
    // Kept as authored: validate/relationReadChecks.mts judges the list.
    clean: (/** @type {unknown} */ value) => value,
};
