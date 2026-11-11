// @typecheck strict
'use strict';

const { usesAllGroup } = require('../../filterForms');

module.exports = {
    since: 3,
    shape: '{ "all": [clause | group, …] }',
    description: 'A group whose entries must all match. Useful inside an any group: (a AND b) OR c.',
    uses: usesAllGroup,
};
