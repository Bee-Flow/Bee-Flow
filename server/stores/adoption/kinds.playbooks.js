// @typecheck strict
/**
 * The playbooks module's kind of the Adoption report (stores/adoption/kinds.js asks for it by
 * name). A playbook has no usage signal. The shape of a kind is in ./kindSql.js.
 */

'use strict';

const { inOrg, objectsSql } = require('./kindSql');

/** @typedef {import('./kindSql').KindDef} KindDef */

/** @type {KindDef[]} */
const KINDS = [
    {
        kind: 'playbook',
        objects: objectsSql(
            `o.id, o.title AS name, o.user_id AS owner, o.created_at, FALSE AS published,
             'private' AS audience, NULL::timestamptz AS published_at`,
            'FROM playbooks o LEFT JOIN users u ON u.id = o.user_id',
            inOrg('o.organization_id'),
        ),
        evidence: null, label: null, peopleKnown: false, itemCost: false,
    },
];

module.exports = { KINDS };
