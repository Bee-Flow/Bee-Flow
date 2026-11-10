// @typecheck strict
'use strict';

const { usesOtherField } = require('../../filterForms');

module.exports = {
    since: 3,
    shape: '{ field, op: eq|neq|gt|gte|lt|lte, otherField: <field key> }',
    description: 'Compares two columns of the same row. The clause carries otherField in place of value.',
    uses: usesOtherField,
};
