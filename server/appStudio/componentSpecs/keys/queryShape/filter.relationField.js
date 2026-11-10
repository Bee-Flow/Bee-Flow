// @typecheck strict
'use strict';

const { usesRelationField } = require('../../filterForms');

module.exports = {
    since: 3,
    shape: '{ field: "<relation field>.<field of the related table>", op, value }',
    description: 'A clause on a field of the row a relation points at. One relation deep, read under the related table\'s own row rules.',
    uses: usesRelationField,
};
