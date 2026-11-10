// @typecheck strict
'use strict';

module.exports = {
    since: 3,
    entryKey: true,
    shape: 'whole number ≥1',
    description: 'Folds a number field onto steps of this width (0, 10, 20, …). The column is named <field>_bin. An entry takes bucket or binWidth, not both.',
    // Kept as authored: validate/aggregateChecks.mts judges the value.
    clean: (/** @type {unknown} */ value) => value,
};
