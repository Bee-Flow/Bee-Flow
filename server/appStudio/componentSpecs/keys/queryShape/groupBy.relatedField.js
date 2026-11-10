// @typecheck strict
'use strict';

module.exports = {
    since: 3,
    entryKey: true,
    shape: '<field key of the related table>',
    description: 'Groups by a column of the row a relation field points at. The column is named <field>_<relatedField>, read under the related table\'s own row rules.',
    // Kept as authored: validate/aggregateChecks.mts judges the value.
    clean: (/** @type {unknown} */ value) => value,
};
