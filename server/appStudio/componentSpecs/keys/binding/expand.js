// @typecheck strict
'use strict';

const { entriesInKeyOrder } = require('../../entryKeyOrder');

module.exports = {
    since: 3,
    kinds: ['record', 'records'],
    shape: '[{ field: <relation field>, pick?: [<field of the related table>], as? }] of 1 to 5 entries',
    description: 'Takes the related row of a relation field along with each record. It lands under <field>_record (or as), one relation deep, read under the related table\'s own row rules. Without pick it carries the relation\'s display field.',
    // Kept as authored, each entry's keys in a fixed order: validate/relationReadChecks.mts judges the list.
    clean: entriesInKeyOrder(['field', 'pick', 'as']),
};
