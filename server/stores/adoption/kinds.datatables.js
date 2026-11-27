// @typecheck strict
/**
 * The datatables module's kind of the Adoption report (stores/adoption/kinds.js asks for it by
 * name). A datatable has no usage signal: the report says "no signal" rather than inventing one.
 * The shape of a kind is in ./kindSql.js.
 */

'use strict';

const { inOrg, audience, objectsSql } = require('./kindSql');

/** @typedef {import('./kindSql').KindDef} KindDef */

/** @type {KindDef[]} */
const KINDS = [
    {
        kind: 'datatable',
        objects: objectsSql(
            `o.id, o.name, o.owner_user_id AS owner, o.created_at, o.is_published AS published,
             ${audience('o.is_published', 'o.shared_groups')} AS audience, NULL::timestamptz AS published_at`,
            'FROM datatables o LEFT JOIN users u ON u.id = o.owner_user_id',
            inOrg('o.organization_id'),
        ),
        evidence: null, label: null, peopleKnown: false, itemCost: false,
    },
];

module.exports = { KINDS };
