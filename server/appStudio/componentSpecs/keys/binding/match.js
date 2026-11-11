// @typecheck strict
'use strict';

/**
 * `match` on a record, records or aggregate binding: how the top-level filters join. The query
 * compiler has always read it on a read request (`match: 'any'` ORs the filters inside one group,
 * the access predicate stays ANDed outside); this mark lets a binding carry it.
 *
 * 'all' is what a binding without the key does, so it is not kept: a definition that spells
 * the default stays the definition it was. Anything but 'any' is dropped with a hint.
 */
module.exports = {
    since: 3,
    kinds: ['record', 'records', 'aggregate'],
    shape: '"any" (leave out for "all", the default)',
    description: 'How the top-level filters join: "any" shows a row when one matches. Without the key every filter must match.',
    clean: (/** @type {unknown} */ value, /** @type {{ path: string, push: (code: string, path: string, message: string) => void }} */ { path, push }) => {
        if (value === 'any') return 'any';
        if (value !== 'all') push('binding.match_dropped', path, 'match is "any" or left out (every filter must match): dropped it.');
        return undefined;
    },
};
