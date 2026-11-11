// @typecheck strict
'use strict';

const { usesNestedGroup } = require('../../filterForms');

module.exports = {
    since: 3,
    shape: '{ "any" | "all": [clause | group, …] }, groups up to 3 levels deep',
    description: 'A group inside a group. A flat list and a one-level any group of clauses are the base forms.',
    uses: usesNestedGroup,
};
