// @typecheck strict
'use strict';

const { usesNotGroup } = require('../../filterForms');

module.exports = {
    since: 3,
    shape: '{ "not": clause | group }',
    description: 'Matches the rows its clause or group does not match.',
    uses: usesNotGroup,
};
